import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const RATIO = 0.52; // %

const KEYBOARD_MAC = 'D0:A3:08:0D:01:F8';
const KEYBOARD_PATH = `/org/bluez/hci0/dev_${KEYBOARD_MAC.replace(/:/g, '_')}`; 
const BUS  = Gio.DBus.system;

export default class CropFoldedScreen {
	enable() {
		this._shown = false;

		// The black, input-eating overlay
		this._overlay = new St.Widget({
			style: 'background-color: black;',
			reactive: true,
			can_focus: true,
			x_expand: true,
			y_expand: false,
		});
		const stop = () => Clutter.EVENT_STOP;
		['button-press-event','button-release-event','scroll-event','motion-event','touch-event','key-press-event','key-release-event']
			.forEach(sig => this._overlay.connect(sig, stop));

		this._reposition = () => {
			const m = Main.layoutManager.primaryMonitor;
			const h = Math.round(m.height * RATIO);
			this._overlay.set_position(m.x, m.y + m.height - h);
			this._overlay.set_size(m.width, h);
		};

		this._subId = BUS.signal_subscribe(
			'org.bluez',                               
			'org.freedesktop.DBus.Properties',         
			'PropertiesChanged',                       
			KEYBOARD_PATH,                             
			'org.bluez.Device1',                       
			Gio.DBusSignalFlags.MATCH_ARG0,            
			(_c, _s, objectPath, _iface, _sig, params) => {
				const [iface, dict ] = params.deepUnpack();  // ← key!
				if ('Connected' in dict) 
					dict.Connected.get_boolean() ? this._onConnect() : this._onDisconnect();
			}
		);
		BUS.call(
			'org.bluez',
			KEYBOARD_PATH,
			'org.freedesktop.DBus.Properties',
			'Get',
			new GLib.Variant('(ss)', ['org.bluez.Device1', 'Connected']),
			null,
			Gio.DBusCallFlags.NONE,
			-1,
			null,
			(conn, res) => {
				try {
					const out = conn.call_finish(res).deepUnpack(); // returns [Variant]
					const isConnected = out[0].deepUnpack();        // unpack the boolean inside the Variant
					if (isConnected)
						this._onConnect();
				} catch (e) {
					// Device path might not exist yet or BlueZ isn't up; safe to ignore.
					log(`[CropBottom] Initial Connected check failed: ${e.message}`);
				}
			}
		);		

	}

	_onConnect() {
		this._show_indicator(); 
	}

	_onDisconnect() {
		this._restore_screen();
		this._hide_indicator();
	}

	disable() {
		this._restore_screen();
		this._hide_indicator();
		if (this._overlay)   { this._overlay.destroy();   this._overlay   = null; }
		if (this._subId)
			BUS.signal_unsubscribe(this._subId);
	}

	_crop_screen() {
		if (this._shown) return;

		Main.layoutManager.addChrome(this._overlay, {
			affectsStruts: true,      // shrink usable area (keep windows above)
			affectsInputRegion: true, // block input below
			trackFullscreen: true
		});
		this._monSig = Main.layoutManager.connect('monitors-changed', () => this._reposition());
		this._reposition();

		this._shown = true;
	}

	_show_indicator() {
		if (this._indicator) 
			return;
		this._indicator = new PanelMenu.Button(0.0, 'CropBottom');
		this._icon = new St.Icon({ icon_name: 'input-keyboard-symbolic', style_class: 'system-status-icon' });
		this._indicator.add_child(this._icon);
		this._click = new Clutter.ClickAction();
		this._indicator.add_action(this._click);
		this._click.connect('clicked', () => this._toggle());
		Main.panel.addToStatusArea('crop-bottom', this._indicator, 1, 'right');
	}

	_toggle() { this._shown ? this._restore_screen() : this._crop_screen(); }

	_restore_screen() {
		if (!this._shown) return;
		if (this._monSig) { Main.layoutManager.disconnect(this._monSig); this._monSig = 0; }
		Main.layoutManager.removeChrome(this._overlay);
		this._shown = false;
	}

	_hide_indicator() {
		if (this._indicator) 
			this._indicator.destroy(); this._indicator = null; 
	}
}


import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

const RATIO = 0.52; // %

const KEYBOARD_MAC = 'D0:A3:08:0D:01:F8';
const KEYBOARD_PATH = `/org/bluez/hci0/dev_${KEYBOARD_MAC.replace(/:/g, '_')}`; 
const BUS  = Gio.DBus.system;

export default class CropFoldedScreen {
	enable() {
		this._enabled = true;
		this._getConnCancellable = new Gio.Cancellable();

		this._shown = false;

		this._overlay = new St.Widget({
			reactive: false,
			can_focus: false,
			x_expand: true,
			y_expand: false,
		});
		this._reposition = () => {
			const m = Main.layoutManager.primaryMonitor;
			const h = Math.round(m.height * RATIO);
			this._overlay.set_position(m.x, m.y + m.height - h);
			this._overlay.set_size(m.width, h);
			this._repositionOverview();
			this._repositionDialogOffset();
		};

		this._subId = BUS.signal_subscribe(
			'org.bluez',                               
			'org.freedesktop.DBus.Properties',         
			'PropertiesChanged',                       
			KEYBOARD_PATH,                             
			'org.bluez.Device1',                       
			Gio.DBusSignalFlags.MATCH_ARG0,            
			(_c, _s, objectPath, _iface, _sig, params) => {
				if (!this._enabled) 
					return;
				const [iface, dict ] = params.deepUnpack();
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
			this._getConnCancellable,
			(conn, res) => {
				if (!this._enabled) 
					return;
				try {
					const out = conn.call_finish(res).deepUnpack(); 
					const isConnected = out[0].deepUnpack();        
					if (isConnected)
						this._onConnect();
				} catch (e) {
					// Device path might not exist yet or BlueZ isn't up; safe to ignore.
					log(`[CropBottom] Initial Connected check failed: ${e.message}`);
				}
			}
		);		

		try {
			const file = Gio.File.new_for_uri(import.meta.url); // path to this JS file
			const extDir = file.get_parent();                   // <extension-root>
			const schemaDir = extDir.get_child('schemas').get_path();
			log(`[CropBottom] schemaDir=${schemaDir}`);

			// 2) Load schema from that directory
			const SCHEMA_ID = 'org.gnome.shell.extensions.crop-bottom';
			const src = Gio.SettingsSchemaSource.new_from_directory(
				schemaDir,
				Gio.SettingsSchemaSource.get_default(),
				/*trusted=*/ false
			);
			const schema = src.lookup(SCHEMA_ID, /*recursive=*/ true);
			if (!schema)
				throw new Error(`Schema ${SCHEMA_ID} not found in ${schemaDir}`);

			this._settings = new Gio.Settings({ settings_schema: schema });
			Main.wm.addKeybinding(
				'toggle-crop',                 // key name from your schema
				this._settings,                // the Gio.Settings you created
				Meta.KeyBindingFlags.NONE,
				Shell.ActionMode.ALL,          // active in normal shell modes
				() => this._toggle()           // your handler
			);
		} catch (e) {
			log(`[CropBottom] addKeybinding failed: ${e.message}`);
		}
	}

	_onConnect() {
		this._show_indicator(); 
	}

	_onDisconnect() {
		this._restore_screen();
		this._hide_indicator();
	}

	disable() {
		this._enabled = false;

		try { this._getConnCancellable?.cancel(); } catch {}
		this._getConnCancellable = null;

		if (this._subId) {
			BUS.signal_unsubscribe(this._subId);
			this._subId = 0; // ensure no dangling id
		}
		this._restore_screen();
		this._hide_indicator();
		if (this._overlay)   { this._overlay.destroy();   this._overlay   = null; }
	}

	_crop_screen() {
		if (this._shown || this._adding) return;
		this._adding = true;
		try {
			this._shown = true;

			Main.layoutManager.addTopChrome(this._overlay, {
				affectsStruts: true,
				affectsInputRegion: false,
				trackFullscreen: false,    // or true, per your choice
			});

			// Portable source of scale-factor changes
			this._themeCtx = St.ThemeContext.get_for_stage(global.stage);

			// Reposition on monitor topology changes
			Main.layoutManager.connectObject(
				'monitors-changed', () => this._reposition(),
				this
			);

			// Reposition when workareas change (panels/docks/struts)
			global.display.connectObject(
				'workareas-changed', () => this._reposition(),
				this
			);

			// Reposition on scale-factor changes (HiDPI / fractional scaling tweaks)
			this._themeCtx.connectObject(
				'notify::scale-factor', () => this._reposition(),
				this
			);

			this._cropOverview();
			this._cropSystemDialog();
		} finally {
			this._adding = false;
		}	
	}
	_getCropHeight() {
		const m = Main.layoutManager.primaryMonitor;
		return Math.round(m.height * RATIO);
	}

	_cropOverview() {
		if (this._overviewOffsetActive) return;
		this._overviewOffsetActive = true;

		// compute initial offset: center of (screen - crop) vs whole screen ⇒ h/2
		this._yOffset = Math.floor(this._getCropHeight() / 2);

		// robust handle for the overview group across shell versions
		const getGroup = () =>
			Main.layoutManager.overviewGroup ?? Main.overview?._overview ?? null;

		const apply = () => {
			const g = getGroup();
			if (g) g.translation_y = -this._yOffset;
		};
		const reset = () => {
			const g = getGroup();
			if (g) g.translation_y = 0;
		};

		// Move overview when it opens, reset when it closes
		Main.overview.connectObject(
			'showing', apply,
			'hiding',  reset,
			this
		);

		// If already visible, apply now
		if (Main.overview.visibleTarget)
			apply();

		// stash for updates/remove
		this._getOverviewGroup = getGroup;
	}

	_cropSystemDialog() {
		if (this._modalOffsetActive) return;
		this._modalOffsetActive = true;

		// group that hosts system modal dialogs (EndSession, Polkit, etc.)
		this._modalGroup = Main.layoutManager.modalDialogGroup ?? null;

		this._repositionDialogOffset();
	}

	_repositionDialogOffset() {
		if (!this._modalOffsetActive) return;
		this._yOffset = Math.floor(this._getCropHeight() / 2);
		if (this._modalGroup)
			this._modalGroup.translation_y = -this._yOffset;
	}

	_repositionOverview() {
		if (!this._overviewOffsetActive) return;
		this._yOffset = Math.floor(this._getCropHeight() / 2);

		// If overview is currently showing, keep it in the right place
		if (Main.overview.visibleTarget) {
			const g = this._getOverviewGroup?.();
			if (g) g.translation_y = -this._yOffset;
		}
	}

	_restore_screen() {
		if (this._removing) return;
		if (!this._shown) { this._restore_overview(); return; }

		try {
			// Block any re-entrant add/reposition during removal
			this._shown = false;

			// Disconnect all the hooks we added while shown
			try { Main.layoutManager.disconnectObject(this); } catch {}
			try { global.display.disconnectObject(this); } catch {}
			try { this._themeCtx?.disconnectObject(this); } catch {}
			this._themeCtx = null;

			// Drop the strut immediately, then untrack the actor
			this._overlay.set_size(0, 0);
			this._overlay.set_position(0, 0);
			try { Main.layoutManager.removeChrome(this._overlay); } catch {}

			// Some Shell versions don’t recompute workareas synchronously here.
			// Nudge the region update; guard for private API.
			try { Main.layoutManager._queueUpdateRegions?.(); } catch {}

			this._restore_overview();
			this._restoreSystemDialog();
		} finally {
			this._removing = false;
		}		
	}

	_restore_overview() {
		if (!this._overviewOffsetActive) return;
		this._overviewOffsetActive = false;

		// disconnect our 'showing'/'hiding' hooks
		try { Main.overview.disconnectObject(this); } catch {}

		// clear any remaining translation
		const g = this._getOverviewGroup?.();
		if (g) g.translation_y = 0;

		this._getOverviewGroup = null;
	}

	_restoreSystemDialog() {
		if (!this._modalOffsetActive) return;
		this._modalOffsetActive = false;

		if (this._modalGroup)
			this._modalGroup.translation_y = 0;

		this._modalGroup = null;
	}

	_show_indicator() {
		if (this._indicator) 
			return;
		this._indicator = new PanelMenu.Button(0.0, 'CropBottom');
		this._icon = new St.Icon({ icon_name: 'input-keyboard-symbolic', style_class: 'system-status-icon' });
		this._indicator.add_child(this._icon);
		this._click = new Clutter.ClickGesture();
		this._click.set_required_button(1); // primary button
		this._indicator.add_action(this._click); // gestures are still Clutter.Action descendants
		this._clickHandlerId = this._click.connect('recognize', () => this._toggle());

		Main.panel.addToStatusArea('crop-bottom', this._indicator, 1, 'right');
	}

	_toggle() { 
		this._shown ? this._restore_screen() : this._crop_screen();
		this._reposition();
	}


	_hide_indicator() {
		if (!this._indicator) return;
		try { if (this._click && this._clickHandlerId) this._click.disconnect(this._clickHandlerId); } catch {}
		this._clickHandlerId = 0;
		this._click = null;
		this._indicator.destroy();
		this._indicator = null;
		this._icon = null;
	}
}


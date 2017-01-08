

/**
 * Constructor for emulator instances.
 *
 * Usage: `var emulator = new V86Starter(options);`
 *
 * Options can have the following properties (all optional, default in parenthesis):
 *
 * - `memory_size number` (16 * 1024 * 1024) - The memory size in bytes, should
 *   be a power of 2.
 * - `vga_memory_size number` (8 * 1024 * 1024) - VGA memory size in bytes.
 *
 * - `autostart boolean` (false) - If emulation should be started when emulator
 *   is ready.
 *
 * - `disable_keyboard boolean` (false) - If the keyboard should be disabled.
 * - `disable_mouse boolean` (false) - If the mouse should be disabled.
 *
 * - `network_relay_url string` (No network card) - The url of a server running
 *   websockproxy. See [networking.md](networking.md). Setting this will
 *   enable an emulated network card.
 *
 * - `bios Object` (No bios) - Either a url pointing to a bios or an
 *   ArrayBuffer, see below.
 * - `vga_bios Object` (No VGA bios) - VGA bios, see below.
 * - `hda Object` (No hard drive) - First hard disk, see below.
 * - `fda Object` (No floppy disk) - First floppy disk, see below.
 * - `cdrom Object` (No CD) - See below.
 * - `initial_state Object` (Normal boot) - An initial state to load, see
 *   [`restore_state`](#restore_statearraybuffer-state) and below.
 *
 * - `filesystem Object` (No 9p filesystem) - A 9p filesystem, see
 *   [filesystem.md](filesystem.md).
 *
 * - `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
 *   that will receive and send data to the emulated serial terminal.
 *   Alternatively the serial terminal can also be accessed programatically,
 *   see [serial.html](../examples/serial.html).
 *
 * - `screen_container HTMLElement` (No screen) - An HTMLElement. This should
 *   have a certain structure, see [basic.html](../examples/basic.html).
 *
 * ***
 *
 * There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):
 *
 * - Pass an object that has a url. Optionally, `async: true` and `size:
 *   size_in_bytes` can be added to the object, so that sectors of the image
 *   are loaded on demand instead of being loaded before boot (slower, but
 *   strongly recommended for big files). In that case, the `Range: bytes=...`
 *   header must be supported on the server.
 *
 *   ```javascript
 *   // download file before boot
 *   options.bios = {
 *       url: "bios/seabios.bin"
 *   }
 *   // download file sectors as requested, size is required
 *   options.hda = {
 *       url: "disk/linux.iso",
 *       async: true,
 *       size: 16 * 1024 * 1024
 *   }
 *   ```
 *
 * - Pass an `ArrayBuffer` or `File` object as `buffer` property.
 *
 *   ```javascript
 *   // use <input type=file>
 *   options.bios = {
 *       buffer: document.all.hd_image.files[0]
 *   }
 *   // start with empty hard drive
 *   options.hda = {
 *       buffer: new ArrayBuffer(16 * 1024 * 1024)
 *   }
 *   ```
 *
 * ***
 */

import { v86 } from "../main";
import { AsyncFileBuffer, AsyncXHRBuffer, SyncBuffer, SyncFileBuffer, load_file } from "../lib";
import { BusConnector, Bus } from "../bus";
import { NetworkAdapter } from "./network";
import { KeyboardAdapter } from "./keyboard";
import { MouseAdapter } from "./mouse";
import { ScreenAdapter } from "./screen";
import { SerialAdapter } from "./serial";
import { dbg_log, dbg_assert } from "../log";
/// <reference path='../lib/filsystem.d.ts' />

export class V86Starter
{
    private cpu_is_running = false;
    private bus: BusConnector;
    private emulator_bus: any;
    public v86: any;
    public disk_images: any;
    private network_adapter: NetworkAdapter;
    private keyboard_adapter: KeyboardAdapter;
    private mouse_adapter: MouseAdapter;
    private screen_adapter: ScreenAdapter;
    private serial_adapter: SerialAdapter;

    private files_to_load = [];
    private fs9p: FS;

    private settings: any = {};
    private total: number;

    constructor(options)
    {
        //var worker = new Worker("src/browser/worker.js");
        //var adapter_bus = this.bus = WorkerBus.init(worker);

        var bus = Bus.create();
        var adapter_bus = this.bus = bus[0];
        this.emulator_bus = bus[1];
        var emulator = this.v86 = new v86(this.emulator_bus);

        this["bus"] = this.bus;
        this.bus.register("emulator-stopped", () =>
        {
            this.cpu_is_running = false;
        }, this);

        this.bus.register("emulator-started", () =>
        {
            this.cpu_is_running = true;
        }, this);

        this.disk_images = {
            "fda": undefined,
            "fdb": undefined,
            "hda": undefined,
            "hdb": undefined,
            "cdrom": undefined,
        };

        this.settings.load_devices = true;
        this.settings.memory_size = options["memory_size"] === undefined ? 64 * 1024 * 1024 : options["memory_size"];
        this.settings.vga_memory_size = options["vga_memory_size"] || 8 * 1024 * 1024;
        this.settings.boot_order = options["boot_order"] || 0x213;
        this.settings.fda = undefined;
        this.settings.fdb = undefined;

        if(options["network_relay_url"])
        {
            this.network_adapter = new NetworkAdapter(options["network_relay_url"], adapter_bus);
            this.settings.enable_ne2k = true;
        }

        if(!options["disable_keyboard"])
        {
            this.keyboard_adapter = new KeyboardAdapter(adapter_bus);
        }
        if(!options["disable_mouse"])
        {
            this.mouse_adapter = new MouseAdapter(adapter_bus, options["screen_container"]);
        }

        if(options["screen_container"])
        {
            this.screen_adapter = new ScreenAdapter(options["screen_container"], adapter_bus);
        }

        if(options["serial_container"])
        {
            this.serial_adapter = new SerialAdapter(options["serial_container"], adapter_bus);
        }


        var image_names = [
            "bios", "vga_bios",
            "cdrom", "hda", "hdb", "fda", "fdb",
            "initial_state",
        ];

        for(var i = 0; i < image_names.length; i++)
        {
            this.add_file(image_names[i], options[image_names[i]]);
        }

        if(options["filesystem"])
        {
            var fs_url = options["filesystem"]["basefs"];
            var base_url = options["filesystem"]["baseurl"];

            this.fs9p = new FS(base_url);
            this.settings.fs9p = this.fs9p;

            if(fs_url)
            {
                console.assert(base_url, "Filesystem: baseurl must be specified");

                var size;

                if(typeof fs_url === "object")
                {
                    size = fs_url["size"];
                    fs_url = fs_url["url"];
                }
                dbg_assert(typeof fs_url === "string");

                this.files_to_load.push({
                    name: "fs9p_json",
                    url: fs_url,
                    size: size,
                    as_text: true,
                });
            }
        }

        this.total = this.files_to_load.length;
    
        this.cont(0);
    }

    // ugly, but required for closure compiler compilation
    public put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                this.settings.hda = this.disk_images["hda"] = buffer;
                break;
            case "hdb":
                this.settings.hdb = this.disk_images["hdb"] = buffer;
                break;
            case "cdrom":
                this.settings.cdrom = this.disk_images["cdrom"] = buffer;
                break;
            case "fda":
                this.settings.fda = this.disk_images["fda"] = buffer;
                break;
            case "fdb":
                this.settings.fdb = this.disk_images["fdb"] = buffer;
                break;

            case "bios":
                this.settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                this.settings.vga_bios = buffer.buffer;
                break;
            case "initial_state":
                this.settings.initial_state = buffer.buffer;
                break;
            case "fs9p_json":
                this.settings.fs9p_json = buffer.buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    public add_file(name, file)
    {
        if(!file)
        {
            return;
        }

        if(file["get"] && file["set"] && file["load"])
        {
            this.files_to_load.push({
                name: name,
                loadable: file,
            });
            return;
        }

        // Anything coming from the outside world needs to be quoted for
        // Closure Compiler compilation
        file = {
            buffer: file["buffer"],
            async: file["async"],
            url: file["url"],
            size: file["size"],
        };

        if(name === "bios" || name === "vga_bios" || name === "initial_state")
        {
            // Ignore async for these because they must be availabe before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(file.buffer instanceof ArrayBuffer)
        {
            this.files_to_load.push({
                name: name,
                loadable: new SyncBuffer(file.buffer),
            });
        }
        else if(typeof File !== "undefined" && file.buffer instanceof File)
        {
            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set

            // Heuristics: If file is smaller than 256M, use SyncFileBuffer
            if(file.async === undefined)
            {
                file.async = file.buffer.size < 256 * 1024 * 1024;
            }

            this.files_to_load.push({
                name: name,
                loadable: file.async
                    ? new SyncFileBuffer(file.buffer)
                    : new AsyncFileBuffer(file.buffer),
            });
        }
        else if(file.url)
        {
            if(file.async)
            {
                var buffer = new AsyncXHRBuffer(file.url, file.size);
                this.files_to_load.push({
                    name: name,
                    loadable: buffer,
                });
            }
            else
            {
                this.files_to_load.push({
                    name: name,
                    url: file.url,
                    size: file.size,
                });
            }
        }
        else
        {
            dbg_log("Ignored file: url=" + file.url + " buffer=" + file.buffer);
        }
    }

    public cont(index)
    {
        if(index === this.total)
        {
            setTimeout(this.done.bind(this), 0);
            return;
        }

        var f = this.files_to_load[index];

        if(f.loadable)
        {
            f.loadable.onload = (e) =>
            {
                this.put_on_settings.call(this, f.name, f.loadable);
                this.cont(index + 1);
            };
            f.loadable.load();
        }
        else
        {
            load_file(f.url, {
                done: (result) =>
                {
                    this.put_on_settings.call(this, f.name, new SyncBuffer(result));
                    this.cont(index + 1);
                },
                progress: (e) =>
                {
                    if(e.target.status === 200)
                    {
                        this.emulator_bus.send("download-progress", {
                            file_index: index,
                            file_count: this.total,
                            file_name: f.url,

                            lengthComputable: e.lengthComputable,
                            total: e.total || f.size,
                            loaded: e.loaded,
                        });
                    }
                    else
                    {
                        this.emulator_bus.send("download-error", {
                            file_index: index,
                            file_count: this.total,
                            file_name: f.url,
                            request: e.target,
                        });
                    }
                },
                as_text: f.as_text,
            });
        }
    }

    public done()
    {
        if(this.settings.initial_state)
        {
            // avoid large allocation now, memory will be restored later anyway
            this.settings.memory_size = 0;
        }

        this.bus.send("cpu-init", this.settings);

        setTimeout(() =>
        {
            if(this.settings.initial_state)
            {
                this.v86.restore_state(this.settings.initial_state);
            }

            setTimeout(() =>
            {
                if(this.settings.fs9p && this.settings.fs9p_json)
                {
                    this.settings.fs9p.OnJSONLoaded(this.settings.fs9p_json);
                }

                if(this.v86["autostart"])
                {
                    this.bus.send("cpu-run");
                }
            }, 0)
        }, 0);
    }

    /**
     * Start emulation. Do nothing if emulator is running already. Can be
     * asynchronous.
     * @export
     */
    public run()
    {
        this.bus.send("cpu-run");
    };

    /**
     * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
     * @export
     */
    public stop()
    {
        this.bus.send("cpu-stop");
    };

    /**
     * @ignore
     * @export
     */
    public destroy()
    {
        this.keyboard_adapter.destroy();
    };

    /**
     * Restart (force a reboot).
     * @export
     */
    public restart()
    {
        this.bus.send("cpu-restart");
    };

    /**
     * Add an event listener (the emulator is an event emitter). A list of events
     * can be found at [events.md](events.md).
     *
     * The callback function gets a single argument which depends on the event.
     *
     * @export
     */
    public add_listener(event: string, listener)
    {
        this.bus.register(event, listener, this);
    };

    /**
     * Remove an event listener.
     *
     * @export
     */
    public remove_listener(event: string, listener)
    {
        this.bus.unregister(event, listener);
    };

    /**
     * Restore the emulator state from the given state, which must be an
     * ArrayBuffer returned by
     * [`save_state`](#save_statefunctionobject-arraybuffer-callback).
     *
     * Note that the state can only be restored correctly if this constructor has
     * been created with the same options as the original instance (e.g., same disk
     * images, memory size, etc.).
     *
     * Different versions of the emulator might use a different format for the
     * state buffer.
     *
     * @export
     */
    public restore_state(state: ArrayBuffer)
    {
        this.v86.restore_state(state);
    };

    /**
     * Asynchronously save the current state of the emulator. The first argument to
     * the callback is an Error object if something went wrong and is null
     * otherwise.
     *
     * @export
     */
    public save_state(callback: (o: any, a: ArrayBuffer) => void)
    {
        // Might become asynchronous at some point

        setTimeout(() =>
        {
            try
            {
                callback(null, this.v86.save_state());
            }
            catch(e)
            {
                callback(e, null);
            }
        }, 0);
    };

    /**
     * Return an object with several statistics. Return value looks similar to
     * (but can be subject to change in future versions or different
     * configurations, so use defensively):
     *
     * ```javascript
     * {
     *     "cpu": {
     *         "instruction_counter": 2821610069
     *     },
     *     "hda": {
     *         "sectors_read": 95240,
     *         "sectors_written": 952,
     *         "bytes_read": 48762880,
     *         "bytes_written": 487424,
     *         "loading": false
     *     },
     *     "cdrom": {
     *         "sectors_read": 0,
     *         "sectors_written": 0,
     *         "bytes_read": 0,
     *         "bytes_written": 0,
     *         "loading": false
     *     },
     *     "mouse": {
     *         "enabled": true
     *     },
     *     "vga": {
     *         "is_graphical": true,
     *         "res_x": 800,
     *         "res_y": 600,
     *         "bpp": 32
     *     }
     * }
     * ```
     *
     * @deprecated
     * @return {Object}
     * @export
     */
    public get_statistics()
    {
        console.warn("V86Starter.prototype.get_statistics is deprecated. Use events instead.");

        var stats: any = {
            cpu: {
                instruction_counter: this.get_instruction_counter(),
            },
        };

        if(!this.v86)
        {
            return stats;
        }

        var devices = this.v86.cpu.devices;

        if(devices.hda)
        {
            stats.hda = devices.hda.stats;
        }

        if(devices.cdrom)
        {
            stats.cdrom = devices.cdrom.stats;
        }

        if(devices.ps2)
        {
            stats["mouse"] = {
                "enabled": devices.ps2.use_mouse,
            };
        }

        if(devices.vga)
        {
            stats["vga"] = {
                "is_graphical": devices.vga.stats.is_graphical,
            };
        }

        return stats;
    };

    /**
     * @return {number}
     * @ignore
     * @export
     */
    public get_instruction_counter()
    {
        if(this.v86)
        {
            return this.v86.cpu.timestamp_counter;
        }
        else
        {
            // TODO: Should be handled using events
            return 0;
        }
    };

    /**
     * @return {boolean}
     * @export
     */
    public is_running()
    {
        return this.cpu_is_running;
    };

    /**
     * Send a sequence of scan codes to the emulated PS2 controller. A list of
     * codes can be found at http://stanislavs.org/helppc/make_codes.html.
     * Do nothing if there is no keyboard controller.
     *
     * @export
     */
    public keyboard_send_scancodes(codes: number[])
    {
        for(var i = 0; i < codes.length; i++)
        {
            this.bus.send("keyboard-code", codes[i]);
        }
    };

    /**
     * Send translated keys
     * @ignore
     * @export
     */
    public keyboard_send_keys(codes)
    {
        for(var i = 0; i < codes.length; i++)
        {
            this.keyboard_adapter.simulate_press(codes[i]);
        }
    };

    /**
     * Send text
     * @ignore
     * @export
     */
    public keyboard_send_text(string)
    {
        setTimeout(() => {
            for(var i = 0; i < string.length; i++)
            {
                this.keyboard_adapter.simulate_char(string[i]);
            }
        }, 0);
    };

    /**
     * Download a screenshot.
     *
     * @ignore
     * @export
     */
    public screen_make_screenshot()
    {
        if(this.screen_adapter)
        {
            this.screen_adapter.make_screenshot();
        }
    };

    /**
     * Set the scaling level of the emulated screen.
     *
     * @ignore
     * @export
     */
    public screen_set_scale(sx: number, sy: number)
    {
        if(this.screen_adapter)
        {
            this.screen_adapter.set_scale(sx, sy);
        }
    };

    /**
     * Go fullscreen.
     *
     * @ignore
     * @export
     */
    public screen_go_fullscreen()
    {
        if(!this.screen_adapter)
        {
            return;
        }

        var elem = document.getElementById("screen_container");

        if(!elem)
        {
            return;
        }

        // bracket notation because otherwise they get renamed by closure compiler
        var fn = elem["requestFullScreen"] ||
                elem["webkitRequestFullscreen"] ||
                elem["mozRequestFullScreen"] ||
                elem["msRequestFullScreen"];

        if(fn)
        {
            fn.call(elem);
        }

        //this.lock_mouse(elem);
        this.lock_mouse();
    };

    /**
     * Lock the mouse cursor: It becomes invisble and is not moved out of the
     * browser window.
     *
     * @ignore
     * @export
     */
    public lock_mouse()
    {
        var elem = document.body;

        var fn = elem["requestPointerLock"] ||
                    elem["mozRequestPointerLock"] ||
                    elem["webkitRequestPointerLock"];

        if(fn)
        {
            fn.call(elem);
        }
    };

    /**
     * Enable or disable sending mouse events to the emulated PS2 controller.
     */
    public mouse_set_status(enabled: boolean)
    {
        if(this.mouse_adapter)
        {
            this.mouse_adapter.emu_enabled = enabled;
        }
    };

    /**
     * Enable or disable sending keyboard events to the emulated PS2 controller.
     * @export
     */
    public keyboard_set_status(enabled: boolean)
    {
        if(this.keyboard_adapter)
        {
            this.keyboard_adapter.emu_enabled = enabled;
        }
    };


    /**
     * Send a string to the first emulated serial terminal.
     * @export
     */
    public serial0_send(data: string)
    {
        for(var i = 0; i < data.length; i++)
        {
            this.bus.send("serial0-input", data.charCodeAt(i));
        }
    };

    /**
     * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
     * been initialized. First argument to the callback is an error object if
     * something went wrong and null otherwise.
     *
     * @export
     */
    public create_file(file: string, data: Uint8Array, callback: (o: any) => void)
    {
        var fs = this.fs9p;

        if(!fs)
        {
            return;
        }

        var parts = file.split("/");
        var filename = parts[parts.length - 1];

        var path_infos = fs.SearchPath(file);
        var parent_id = path_infos.parentid;
        var not_found = filename === "" || parent_id === -1

        if(!not_found)
        {
            fs.CreateBinaryFile(filename, parent_id, data);
        }

        if(callback)
        {
            setTimeout(() =>
            {
                if(not_found)
                {
                    callback(new FileNotFoundError());
                }
                else
                {
                    callback(null);
                }
            }, 0);
        }
    };

    /**
     * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
     * initialized.
     *
     * @export
     */
    public read_file(file: string, callback: (o: any, a: Uint8Array) => void)
    {
        var fs = this.fs9p;

        if(!fs)
        {
            return;
        }

        var path_infos = fs.SearchPath(file);
        var id = path_infos.id;

        if(id === -1)
        {
            callback(new FileNotFoundError(), null);
        }
        else
        {
            fs.OpenInode(id, undefined);
            fs.AddEvent(
                id,
                () =>
                {
                    var data = fs.inodedata[id];

                    if(data)
                    {
                        callback(null, data.subarray(0, fs.inodes[id].size));
                    }
                    else
                    {
                        callback(new FileNotFoundError(), null);
                    }
                }
            );
        }
    };
}

/**
 * @ignore
 */
class FileNotFoundError extends Error
{
    constructor(message = "File not found")
    {
        super(message);
    }
}

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;
    window["V86"] = V86Starter;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86Starter"] = V86Starter;
    self["V86"] = V86Starter;
}
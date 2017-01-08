import { V86Starter } from "./src/browser/starter";
import { dump_file } from "./src/browser/main";
import { dbg_log, dbg_assert } from "./src/log";
import * as v86util from "./src/lib";

function $(id)
{
    var el = document.getElementById(id);

    if(!el)
    {
        dbg_log("Element with id `" + id + "` not found");
    }

    return el;
}

function init_ui(settings, emulator)
{
    $("runtime_options").style.display = "block";
    $("runtime_infos").style.display = "block";

    $("run").onclick = () =>
    {
        if(emulator.is_running())
        {
            ($("run") as HTMLInputElement).value = "Run";
            emulator.stop();
        }
        else
        {
            ($("run") as HTMLInputElement).value = "Pause";
            emulator.run();
        }

        $("run").blur();
    };

    $("exit").onclick = () =>
    {
        emulator.stop();
        location.href = location.pathname;
    };

    $("lock_mouse").onclick = () =>
    {
        if(!mouse_is_enabled)
        {
            $("toggle_mouse").onclick(null);
        }

        emulator.lock_mouse();
        $("lock_mouse").blur();
    };

    var mouse_is_enabled = true;

    $("toggle_mouse").onclick = () =>
    {
        mouse_is_enabled = !mouse_is_enabled;

        emulator.mouse_set_status(mouse_is_enabled);
        ($("toggle_mouse") as HTMLInputElement).value = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
        $("toggle_mouse").blur();
    };


    var last_tick = 0;
    var running_time = 0;
    var last_instr_counter = 0;
    var interval;
    var os_uses_mouse = false;

    function update_info()
    {
        var now = Date.now();

        var instruction_counter = emulator.get_instruction_counter();
        var last_ips = instruction_counter - last_instr_counter;

        last_instr_counter = instruction_counter;

        var delta_time = now - last_tick;
        running_time += delta_time;
        last_tick = now;

        $("speed").textContent = (last_ips / delta_time | 0) + "";
        $("avg_speed").textContent = (instruction_counter / running_time | 0) + "";
        $("running_time").textContent = time2str(running_time / 1000 | 0);
    }

    emulator.add_listener("emulator-started", () =>
    {
        last_tick = Date.now();
        interval = setInterval(update_info, 1000);
    });

    emulator.add_listener("emulator-stopped", () =>
    {
        update_info();
        clearInterval(interval);
    });

    var stats_9p = {
        read: 0,
        write: 0,
    };

    var stats_storage = {
        read: 0,
        read_sectors: 0,
        write: 0,
        write_sectors: 0,
    };

    emulator.add_listener("ide-read-start", () =>
    {
        $("info_storage").style.display = "block";
        $("info_storage_status").textContent = "Loading ...";
    });
    emulator.add_listener("ide-read-end", (args) =>
    {
        stats_storage.read += args[1];
        stats_storage.read_sectors += args[2];

        $("info_storage_status").textContent = "Idle";
        $("info_storage_bytes_read").textContent = stats_storage.read + "";
        $("info_storage_sectors_read").textContent = stats_storage.read_sectors + "";
    });
    emulator.add_listener("ide-write-end", (args) =>
    {
        stats_storage.write += args[1];
        stats_storage.write_sectors += args[2];

        $("info_storage_bytes_written").textContent = stats_storage.write + "";
        $("info_storage_sectors_written").textContent = stats_storage.write_sectors + "";
    });

    var stats_net = {
        bytes_transmitted: 0,
        bytes_received: 0,
    };

    emulator.add_listener("mouse-enable", (is_enabled) =>
    {
        os_uses_mouse = is_enabled;
        $("info_mouse_enabled").textContent = is_enabled ? "Yes" : "No";
    });

    emulator.add_listener("screen-set-mode", (is_graphical) =>
    {
        if(is_graphical)
        {
            $("info_vga_mode").textContent = "Graphical";
        }
        else
        {
            $("info_vga_mode").textContent = "Text";
            $("info_res").textContent = "-";
            $("info_bpp").textContent = "-";
        }
    });
    emulator.add_listener("screen-set-size-graphical", (args) =>
    {
        $("info_res").textContent = args[0] + "x" + args[1];
        $("info_bpp").textContent = args[2];
    });


    $("reset").onclick = () =>
    {
        emulator.restart();
        $("reset").blur();
    };

    $("memory_dump").onclick = () =>
    {
        dump_file(emulator.v86.cpu.mem8, "v86memory.bin");
        $("memory_dump").blur();
    };

    $("save_state").onclick = () =>
    {
        emulator.save_state((error, result) =>
        {
            if(error)
            {
                console.log(error.stack);
                console.log("Couldn't save state: ", error);
            }
            else
            {
                dump_file(result, "v86state.bin");
            }
        });

        $("save_state").blur();
    };

    $("load_state").onclick = () =>
    {
        $("load_state_input").click();
        $("load_state").blur();
    };

    $("load_state_input").onchange = () =>
    {
        var x = $("load_state_input") as HTMLInputElement;
        var file = x.files[0];

        if(!file)
        {
            return;
        }

        var was_running = emulator.is_running();

        if(was_running)
        {
            emulator.stop();
        }

        var filereader = new FileReader();
        filereader.onload = (e) =>
        {
            try
            {
                emulator.restore_state((<any>e.target).result);
            }
            catch(e)
            {
                alert("Something bad happened while restoring the state:\n" + e + "\n\n" +
                        "Note that the current configuration must be the same as the original");
                throw e;
            }

            if(was_running)
            {
                emulator.run();
            }
        };
        filereader.readAsArrayBuffer(file);

        x.value = "";
    };

    $("ctrlaltdel").onclick = () =>
    {
        emulator.keyboard_send_scancodes([
            0x1D, // ctrl
            0x38, // alt
            0x53, // delete

            // break codes
            0x1D | 0x80,
            0x38 | 0x80,
            0x53 | 0x80,
        ]);

        $("ctrlaltdel").blur();
    };

    $("alttab").onclick = () =>
    {
        emulator.keyboard_send_scancodes([
            0x38, // alt
            0x0F, // tab
        ]);

        setTimeout(() =>
        {
            emulator.keyboard_send_scancodes([
                0x38 | 0x80,
                0x0F | 0x80,
            ]);
        }, 100);

        $("alttab").blur();
    };

    $("scale").onchange = () =>
    {
        var n = parseFloat(($("scale") as HTMLInputElement).value);

        if(n || n > 0)
        {
            emulator.screen_set_scale(n, n);
        }
    };

    $("fullscreen").onclick = () =>
    {
        emulator.screen_go_fullscreen();
    };

    $("screen_container").onclick = () =>
    {
        if(mouse_is_enabled && os_uses_mouse)
        {
            emulator.lock_mouse();
            $("lock_mouse").blur();
        }
    };

    $("take_screenshot").onclick = () =>
    {
        emulator.screen_make_screenshot();

        $("take_screenshot").blur();
    };

    $("serial").style.display = "block";

    window.addEventListener("keydown", ctrl_w_rescue, false);
    window.addEventListener("keyup", ctrl_w_rescue, false);
    window.addEventListener("blur", ctrl_w_rescue, false);

    function ctrl_w_rescue(e)
    {
        if(e.ctrlKey)
        {
            window.onbeforeunload = () =>
            {
                window.onbeforeunload = null;
                return "CTRL-W cannot be sent to the emulator.";
            }
        }
        else
        {
            window.onbeforeunload = null;
        }
    }
}


function start_emulation(settings, done)
{
    /** @const */
    var MB = 1024 * 1024;

    var memory_size = settings.memory_size;

    if(!memory_size)
    {
        memory_size = parseInt(($("memory_size") as HTMLInputElement).value, 10) * MB;

        if(!memory_size)
        {
            alert("Invalid memory size - reset to 128MB");
            memory_size = 128 * MB;
        }
    }

    var vga_memory_size = settings.vga_memory_size;

    /** @const */
    var BIOSPATH = "bios/";

    if(settings.use_bochs_bios)
    {
        var biosfile = "bochs-bios.bin";
        var vgabiosfile = "bochs-vgabios.bin";
    }
    else
    {
        var biosfile = DEBUG ? "seabios-debug.bin" : "seabios.bin";
        var vgabiosfile = DEBUG ? "vgabios-debug.bin" : "vgabios.bin";
        //var biosfile = DEBUG ? "seabios-ultradebug.bin" : "seabios.bin";
        //var vgabiosfile = DEBUG ? "vgabios-ultradebug.bin" : "vgabios.bin";
    }

    //var biosfile = "seabios-qemu.bin";
    //var vgabiosfile = "vgabios-qemu.bin";

    var bios;
    var vga_bios;

    // a bios is only needed if the machine is booted
    if(!settings.initial_state)
    {
        bios = {
            "url": BIOSPATH + biosfile,
        };
        vga_bios = {
            "url": BIOSPATH + vgabiosfile,
        };
    }

    var emulator = new V86Starter({
        "memory_size": memory_size,
        "vga_memory_size": vga_memory_size,

        "screen_container": $("screen_container"),
        "serial_container": $("serial"),

        "boot_order": settings.boot_order || parseInt(($("boot_order") as HTMLInputElement).value, 16) || 0,

        "network_relay_url": "wss://relay.widgetry.org/",
        //"network_relay_url": "ws://localhost:8001/",

        "bios": bios,
        "vga_bios": vga_bios,

        "fda": settings.fda,
        "hda": settings.hda,
        "cdrom": settings.cdrom,

        "initial_state": settings.initial_state,
        "filesystem": settings.filesystem || {},

        "autostart": false,
    });

    if(DEBUG) window["emulator"] = emulator;

    emulator.add_listener("emulator-ready", () =>
    {
        if(DEBUG)
        {
            //debug_start(emulator);
        }

        init_ui(settings, emulator);

        done && done(emulator);
    });

    emulator.add_listener("download-progress", (e) =>
    {
        console.log(e);
    });

    emulator.add_listener("download-error", (e) =>
    {
        console.log("Loading " + e.file_name + " failed. Check your connection " +
                            "and reload the page to try again.");
    });
};

function main()
{
    var settings: any = {};
    settings.initial_state = {
        "url": "images/AOE/v86state_ingame_bench.bin",
        "size": 75726848,
    };
    settings.hda = {
        "url": "images/AOE/windows98x.img",
        "async": true,
        "size": 300 * 1024 * 1024,
    };
    settings.memory_size = 64 * 1024 * 1024;
    settings.vga_memory_size = 8 * 1024 * 1024;
    settings.id = "windows98";
    settings.boot_order = 0x132;

    start_emulation(settings, null);
}

function time2str(time)
{
    if(time < 60)
    {
        return time + "s";
    }
    else if(time < 3600)
    {
        return (time / 60 | 0) + "m " + v86util.pad0(time % 60, 2) + "s";
    }
    else
    {
        return (time / 3600 | 0) + "h " +
            v86util.pad0((time / 60 | 0) % 60, 2) + "m " +
            v86util.pad0(time % 60, 2) + "s";
    }
}

main();
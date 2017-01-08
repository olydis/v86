import { h } from "./lib";
import { CPU } from "./cpu";
import { ticks } from "./hpet";
import { dbg_log, dbg_assert } from "./log";

export class v86
{
    private first_init = true;
    private running = false;
    private stopped = false;
    private cpu = new CPU();

    constructor(private bus)
    {
        bus.register("cpu-init", (settings) => this.init(settings), this);
        bus.register("cpu-run", () => this.run(), this);
        bus.register("cpu-stop", () => this.stop(), this);
        bus.register("cpu-restart", () => this.restart(), this);
    }

    public fast_next_tick()
    {
        console.assert(false);
    }

    public next_tick(time)
    {
        console.assert(false);
    }

    public run()
    {
        if(!this.running)
        {
            this.bus.send("emulator-started");
            this.fast_next_tick();
        }
    }

    public do_tick()
    {
        if(this.stopped)
        {
            this.stopped = this.running = false;
            this.bus.send("emulator-stopped");
            return;
        }

        this.running = true;
        var dt = this.cpu.main_run();
        dbg_assert(typeof dt === "number" && isFinite(dt));

        if(dt <= 0)
        {
            this.fast_next_tick();
        }
        else
        {
            this.next_tick(dt);
        }
    }

    public stop()
    {
        if(this.running)
        {
            this.stopped = true;
        }
    }

    public restart()
    {
        this.cpu.reset();
        this.cpu.load_bios();
    }

    public init(settings)
    {
        if(this.first_init)
        {
            this.first_init = false;
            this.lazy_init();
        }

        this.cpu.init(settings, this.bus);
        this.bus.send("emulator-ready");
    }

    // initialization that only needs to be once
    public lazy_init()
    {
        var emulator = this;

        if(typeof setImmediate !== "undefined")
        {
            this.fast_next_tick = () =>
            {
                setImmediate(() => emulator.do_tick());
            };
        }
        else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
        {
            // setImmediate shim for the browser.
            // TODO: Make this deactivatable, for other applications
            //       using postMessage

            /** @const */
            var MAGIC_POST_MESSAGE = 0xAA55;

            window.addEventListener("message", (e) =>
            {
                if(e.source === window && e.data === MAGIC_POST_MESSAGE)
                {
                    e.stopPropagation();
                    emulator.do_tick();
                }
            }, true);

            this.fast_next_tick = () =>
            {
                window.postMessage(MAGIC_POST_MESSAGE, "*");
            };
        }
        else
        {
            this.fast_next_tick = () =>
            {
                setTimeout(() => emulator.do_tick(), 0);
            };
        }

        if(typeof document !== "undefined" && typeof document.hidden === "boolean")
        {
            this.next_tick = (t) =>
            {
                if(t < 4 || document.hidden)
                {
                    // Avoid sleeping for 1 second (happens if page is not
                    // visible), it can break boot processes. Also don't try to
                    // sleep for less than 4ms, since the value is clamped up
                    this.fast_next_tick();
                }
                else
                {
                    setTimeout(() => emulator.do_tick(), t);
                }
            };
        }
        else
        {
            // In environments that aren't browsers, we might as well use setTimeout
            this.next_tick = (t) =>
            {
                setTimeout(() => emulator.do_tick(), t);
            };
        }
    }

    public save_state()
    {
        // TODO: Should be implemented here, not on cpu
        return this.cpu.save_state();
    }

    public restore_state(state)
    {
        // TODO: Should be implemented here, not on cpu
        return this.cpu.restore_state(state);
    }

    public static microtick: () => number;
    public static has_rand_int: () => boolean;
    public static get_rand_int: () => number;
}

if(typeof performance === "object" && performance.now)
{
    v86.microtick = () =>
    {
        return performance.now();
    };
}
//else if(typeof process === "object" && process.hrtime)
//{
//    v86.microtick()
//    {
//        var t = process.hrtime();
//        return t[0] * 1000 + t[1] / 1e6;
//    };
//}
else
{
    v86.microtick = () => ticks();
}


if(typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues)
{
    var _rand_data = new Int32Array(1);

    v86.has_rand_int = () =>
    {
        return true;
    };

    v86.get_rand_int = () =>
    {
        window.crypto.getRandomValues(_rand_data);
        return _rand_data[0];
    };
}
else
{
    v86.has_rand_int = () =>
    {
        return false;
    };

    v86.get_rand_int = () =>
    {
        console.assert(false);
        throw null;
    };
}

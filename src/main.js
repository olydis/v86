"use strict";

/** @constructor */
function v86(bus)
{
    /** @type {boolean} */
    this.first_init = true;

    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopped = false;

    /** @type {CPU} */
    this.cpu = new CPU();

    this.bus = bus;
    bus.register("cpu-init", this.init, this);
    bus.register("cpu-run", this.run, this);
    bus.register("cpu-stop", this.stop, this);
    bus.register("cpu-restart", this.restart, this);

    this.fast_next_tick = function() { console.assert(false); };
    this.next_tick = function(time) { console.assert(false); };
}

v86.prototype.run = function()
{
    if(!this.running)
    {
        this.bus.send("emulator-started");
        this.fast_next_tick();
    }
};

v86.prototype.do_tick = function()
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
};

v86.prototype.stop = function()
{
    if(this.running)
    {
        this.stopped = true;
    }
};

v86.prototype.restart = function()
{
    this.cpu.reset();
    this.cpu.load_bios();
};

v86.prototype.init = function(settings)
{
    if(this.first_init)
    {
        this.first_init = false;
        this.lazy_init();
    }

    this.cpu.init(settings, this.bus);
    this.bus.send("emulator-ready");
};

// initialization that only needs to be once
v86.prototype.lazy_init = function()
{
    var emulator = this;

    if(typeof setImmediate !== "undefined")
    {
        this.fast_next_tick = function()
        {
            setImmediate(function() { emulator.do_tick(); });
        };
    }
    //else if(typeof Promise !== "undefined")
    //{
    //    var promise = Promise.resolve();
    //    this.fast_next_tick = function()
    //    {
    //        promise.then(function() { emulator.do_tick(); });
    //    };
    //}
    //else if((typeof MutationObserver !== "undefined") &&
    //        !(typeof window !== "undefined" &&
    //            window.navigator &&
    //            window.navigator.standalone))
    //{
    //    this.fast_next_tick = (function() {
    //        // Using 2 mutation observers to batch multiple updates into one.
    //        var div = document.createElement("div");
    //        var opts = {attributes: true};
    //        var toggleScheduled = false;
    //        var div2 = document.createElement("div");
    //        var o2 = new MutationObserver(function() {
    //            div.classList.toggle("foo");
    //            toggleScheduled = false;
    //        });
    //        o2.observe(div2, opts);
    //        var scheduleToggle = function() {
    //            if (toggleScheduled) return;
    //            toggleScheduled = true;
    //            div2.classList.toggle("foo");
    //        };
    //        return function schedule() {
    //            var o = new MutationObserver(function() {
    //                o.disconnect();
    //                emulator.do_tick();
    //            });
    //            o.observe(div, opts);
    //            scheduleToggle();
    //        };
    //    })();
    //}
    //else if(typeof MessageChannel === "function") // works well but not in safari
    //{
    //    // setImmediate shim for the browser.
    //    var channel = new MessageChannel();
    //    var port = channel.port2;
    //    //channel.port1.emulator = this;
    //    //console.log(this.port, channel);
    //    channel.port1.onmessage = function()
    //    {
    //        //debugger;
    //        //console.log(this);
    //        emulator.do_tick();
    //    };
    //    this.fast_next_tick = function()
    //    {
    //        port.postMessage(undefined);
    //    };
    //}
    else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
    {
        // setImmediate shim for the browser.
        // TODO: Make this deactivatable, for other applications
        //       using postMessage

        /** @const */
        var MAGIC_POST_MESSAGE = 0xAA55;

        window.addEventListener("message", function(e)
        {
            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
            {
                e.stopPropagation();
                emulator.do_tick();
            }
        }, true);

        this.fast_next_tick = function()
        {
            window.postMessage(MAGIC_POST_MESSAGE, "*");
        };
    }
    //else if(typeof requestAnimationFrame !== "undefined")
    //{
    //    this.fast_next_tick = function()
    //    {
    //        requestAnimationFrame(function() { emulator.do_tick(); });
    //    };
    //}
    else
    {
        this.fast_next_tick = function()
        {
            setTimeout(function() { emulator.do_tick(); }, 0);
        };
    }

    if(typeof document !== "undefined" && typeof document.hidden === "boolean")
    {
        this.next_tick = function(t)
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
                setTimeout(function() { emulator.do_tick(); }, t);
            }
        };
    }
    else
    {
        // In environments that aren't browsers, we might as well use setTimeout
        this.next_tick = function(t)
        {
            setTimeout(function() { emulator.do_tick(); }, t);
        };
    }
};

v86.prototype.save_state = function()
{
    // TODO: Should be implemented here, not on cpu
    return this.cpu.save_state();
};

v86.prototype.restore_state = function(state)
{
    // TODO: Should be implemented here, not on cpu
    return this.cpu.restore_state(state);
};


if(typeof performance === "object" && performance.now)
{
    v86.microtick = function()
    {
        return ticks();
    };
}
//else if(typeof process === "object" && process.hrtime)
//{
//    v86.microtick = function()
//    {
//        var t = process.hrtime();
//        return t[0] * 1000 + t[1] / 1e6;
//    };
//}
else
{
    v86.microtick = Date.now;
}


if(typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues)
{
    v86._rand_data = new Int32Array(1);

    v86.has_rand_int = function()
    {
        return true;
    };

    v86.get_rand_int = function()
    {
        window.crypto.getRandomValues(v86._rand_data);
        return v86._rand_data[0];
    };
}
else
{
    v86.has_rand_int = function()
    {
        return false;
    };

    v86.get_rand_int = function()
    {
        console.assert(false);
    };
}

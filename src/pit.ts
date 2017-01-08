import { h } from "./lib";
import { BusConnector } from "./bus";
import { CPU } from "./cpu";
import { v86 } from "./main";
import { dbg_log, dbg_assert } from "./log";


/**
 * @const
 * In kHz
 */
var OSCILLATOR_FREQ = 1193.1816666; // 1.193182 MHz

export class PIT
{
    private counter_start_time = new Float64Array(3);
    private counter_start_value = new Uint16Array(3);

    private counter_next_low = new Uint8Array(4);
    private counter_enabled = new Uint8Array(4);
    private counter_mode = new Uint8Array(4);
    private counter_read_mode = new Uint8Array(4);

    // 2 = latch low, 1 = latch high, 0 = no latch
    private counter_latch = new Uint8Array(4);
    private counter_latch_value = new Uint16Array(3);

    private counter_reload = new Uint16Array(3);

    /**
     * Programmable Interval Timer
     */
    constructor(private readonly cpu: CPU)
    {
        // TODO:
        // - counter2 can be controlled by an input

        cpu.io.register_read(0x61, this, () =>
        {
            var now = v86.microtick();

            var ref_toggle = (now * (1000 * 1000 / 15000)) & 1;
            var counter2_out = this.did_rollover(2, now) ? 1 : 0;

            return ref_toggle << 4 | counter2_out << 5;
        });

        cpu.io.register_read(0x40, this, () => this.counter_read(0));
        cpu.io.register_read(0x41, this, () => this.counter_read(1));
        cpu.io.register_read(0x42, this, () => this.counter_read(2));

        cpu.io.register_write(0x40, this, (data) => this.counter_write(0, data));
        cpu.io.register_write(0x41, this, (data) => this.counter_write(1, data));
        cpu.io.register_write(0x42, this, (data) => this.counter_write(2, data));

        cpu.io.register_write(0x43, this, (data) => this.port43_write(data));
    }

    public get_state()
    {
        var state = [];

        state[0] = this.counter_next_low;
        state[1] = this.counter_enabled;
        state[2] = this.counter_mode;
        state[3] = this.counter_read_mode;
        state[4] = this.counter_latch;
        state[5] = this.counter_latch_value;
        state[6] = this.counter_reload;
        state[7] = this.counter_start_time;
        state[8] = this.counter_start_value;

        return state;
    };

    public set_state(state)
    {
        this.counter_next_low = state[0];
        this.counter_enabled = state[1];
        this.counter_mode = state[2];
        this.counter_read_mode = state[3];
        this.counter_latch = state[4];
        this.counter_latch_value = state[5];
        this.counter_reload = state[6];
        this.counter_start_time = state[7];
        this.counter_start_value = state[8];
    };

    public timer(now, no_irq)
    {
        var time_to_next_interrupt = 100;

        // counter 0 produces interrupts
        if(!no_irq)
        {
            if(this.counter_enabled[0] && this.did_rollover(0, now))
            {
                time_to_next_interrupt = 0;

                this.counter_start_value[0] = this.get_counter_value(0, now);
                this.counter_start_time[0] = now;

                dbg_log("pit interrupt. new value: " + this.counter_start_value[0], LOG_PIT);

                this.cpu.device_raise_irq(0);
                var mode = this.counter_mode[0];

                if(mode === 0)
                {
                    this.counter_enabled[0] = 0;
                }
            }
            else
            {
                this.cpu.device_lower_irq(0);
            }
        }
        time_to_next_interrupt = 0;

        return time_to_next_interrupt;
    };

    public get_counter_value(i, now)
    {
        if(!this.counter_enabled[i])
        {
            return 0;
        }

        var diff = now - this.counter_start_time[i];
        var diff_in_ticks = Math.floor(diff * OSCILLATOR_FREQ);

        var value = this.counter_start_value[i] - diff_in_ticks;

        dbg_log("diff=" + diff + " dticks=" + diff_in_ticks + " value=" + value + " reload=" + this.counter_reload[i], LOG_PIT);

        if(value < 0)
        {
            var reload = this.counter_reload[i];
            value = value % reload + reload;
        }

        return value;
    };

    public did_rollover(i, now)
    {
        var diff = now - this.counter_start_time[i];

        if(diff < 0)
        {
            // should only happen after restore_state
            dbg_log("Warning: PIT timer difference is negative, resetting");
            return true;
        }
        var diff_in_ticks = Math.floor(diff * OSCILLATOR_FREQ);
        //dbg_log(i + ": diff=" + diff + " start_time=" + this.counter_start_time[i] + " diff_in_ticks=" + diff_in_ticks + " (" + diff * OSCILLATOR_FREQ + ") start_value=" + this.counter_start_value[i] + " did_rollover=" + (this.counter_start_value[i] < diff_in_ticks), LOG_PIT);

        return this.counter_start_value[i] < diff_in_ticks;
    };

    public counter_read(i)
    {
        var latch = this.counter_latch[i];

        if(latch)
        {
            this.counter_latch[i]--;

            if(latch === 2)
            {
                return this.counter_latch_value[i] & 0xFF;
            }
            else
            {
                return this.counter_latch_value[i] >> 8;
            }
        }
        else
        {
            var next_low = this.counter_next_low[i];

            if(this.counter_mode[i] === 3)
            {
                this.counter_next_low[i] ^= 1;
            }

            var value = this.get_counter_value(i, v86.microtick());

            if(next_low)
            {
                return value & 0xFF;
            }
            else
            {
                return value >> 8;
            }
        }
    };

    public counter_write(i, value)
    {
        if(this.counter_next_low[i])
        {
            this.counter_reload[i] = this.counter_reload[i] & ~0xFF | value;
        }
        else
        {
            this.counter_reload[i] = this.counter_reload[i] & 0xFF | value << 8;
        }

        if(this.counter_read_mode[i] !== 3 || !this.counter_next_low[i])
        {
            if(!this.counter_reload[i])
            {
                this.counter_reload[i] = 0xFFFF;
            }

            // depends on the mode, should actually
            // happen on the first tick
            this.counter_start_value[i] = this.counter_reload[i];

            this.counter_enabled[i] = 1;

            this.counter_start_time[i] = v86.microtick();

            dbg_log("counter" + i + " reload=" + h(this.counter_reload[i]) +
                    " tick=" + (this.counter_reload[i] || 0x10000) / OSCILLATOR_FREQ + "ms", LOG_PIT);
        }

        if(this.counter_read_mode[i] === 3)
        {
            this.counter_next_low[i] ^= 1;
        }
    };

    public port43_write(reg_byte)
    {
        var mode = reg_byte >> 1 & 7,
            binary_mode = reg_byte & 1,
            i = reg_byte >> 6 & 3,
            read_mode = reg_byte >> 4 & 3;

        if(i === 1)
        {
            dbg_log("Unimplemented timer1", LOG_PIT);
        }

        if(i === 3)
        {
            dbg_log("Unimplemented read back", LOG_PIT);
            return;
        }

        if(read_mode === 0)
        {
            // latch
            this.counter_latch[i] = 2;
            var value = this.get_counter_value(i, v86.microtick());
            dbg_log("latch: " + value, LOG_PIT);
            this.counter_latch_value[i] = value ? value - 1 : 0

            return;
        }

        if(mode >= 6)
        {
            // 6 and 7 are aliased to 2 and 3
            mode &= ~4;
        }

        dbg_log("Control: mode=" + mode + " ctr=" + i +
                " read_mode=" + read_mode + " bcd=" + binary_mode, LOG_PIT);

        if(read_mode === 1)
        {
            // msb
            this.counter_next_low[i] = 0;
        }
        else if(read_mode === 2)
        {
            // lsb
            this.counter_next_low[i] = 1;
        }
        else
        {
            // first lsb then msb
            this.counter_next_low[i] = 1;
        }

        if(i === 0)
        {
            this.cpu.device_lower_irq(0);
        }

        if(mode === 0)
        {
        }
        else if(mode === 3 || mode === 2)
        {
            // what is the difference
        }
        else
        {
            dbg_log("Unimplemented counter mode: " + h(mode), LOG_PIT);
        }

        this.counter_mode[i] = mode;
        this.counter_read_mode[i] = read_mode;
    };
}
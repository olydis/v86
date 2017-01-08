import { h } from "./lib";
import { dbg_log, dbg_assert } from "./log";
import { CPU } from "./cpu";


var HPET_ADDR = 0xFED00000,
    HPET_PERIOD = 0x05F5E100, // in nano seconds
    HPET_FREQ_MS = 1e12 / HPET_PERIOD, // in kHZ
    HPET_SUPPORT_64 = 0,
    HPET_COUNTER_CONFIG = 1 << 4 | HPET_SUPPORT_64 << 5,
    HPET_COUNTER_CONFIG_MASK = 1 << 4 | 1 << 5 | 1 << 15,
    HPET_NUM_COUNTERS = 4;

/**
 * HPET - High Precision Event Timer
 * http://wiki.osdev.org/HPET
 */

// function ticks(): number
// {
//     return Date.now();
// }
var pseudo_time: number = 1483911185593;
export function ticks(): number
{
    pseudo_time += 1;
    return pseudo_time;
}

export class HPET
{
    public legacy_mode = false;
    private hpet_enabled = false;
    private hpet_start = ticks();

    private hpet_offset_low = 0;
    private hpet_offset_high = 0;

    private counter_read_acc_next = false;
    private interrupt_status = 0;

    private counter_config = new Int32Array(HPET_NUM_COUNTERS << 1);
    private counter_comparator = new Int32Array(HPET_NUM_COUNTERS << 1);
    private counter_accumulator = new Int32Array(HPET_NUM_COUNTERS << 1);
    // private counter_last_irq = new Int32Array(HPET_NUM_COUNTERS << 1);

    private last_check = 0;

    constructor(private cpu: CPU)
    {
        cpu.io.mmap_register(HPET_ADDR, 0x4000, addr => this.mmio_read(addr), (addr, data) => this.mmio_write(addr, data));
    }

    public timer(now): void
    {
        if(!this.hpet_enabled)
        {
            return;
        }

        var
            counter_value = this.get_counter() >>> 0,
            config,
            //last_irq,
            comparator,
            do_irq;

        for(var i = 0; i < HPET_NUM_COUNTERS; i++)
        {
            config = this.counter_config[i << 1];
            //last_irq = counter_last_irq[i << 1] >>> 0;
            comparator = this.counter_comparator[i << 1] >>> 0;

            if(this.last_check <= counter_value ?
                    comparator > this.last_check && comparator <= counter_value :
                    comparator > this.last_check || comparator <= counter_value
            ) {
                do_irq = config & 4;
                //counter_last_irq[i << 1] = comparator;

                if(config & 2)
                {
                    // level triggered
                    do_irq = do_irq && !(this.interrupt_status & 1 << i);
                    this.interrupt_status |= 1 << i;
                }
                else
                {
                    // edge-triggered
                    this.interrupt_status &= ~(1 << i);
                }

                if(config & 1 << 3)
                {
                    // periodic mode
                    this.counter_comparator[i << 1] += this.counter_accumulator[i << 1];
                }

                //dbg_log("do_irq=" + do_irq, LOG_HPET);
                if(do_irq)
                {
                    if(this.legacy_mode && i === 0)
                    {
                        this.cpu.device_raise_irq(0);
                    }
                    else if(this.legacy_mode && i === 1)
                    {
                        this.cpu.device_raise_irq(0);
                    }
                    else
                    {
                        // TODO
                        this.cpu.device_raise_irq(0);
                    }
                }
            }
        }

        this.last_check = counter_value;
    }

    public get_counter(): number
    {
        if(this.hpet_enabled)
        {
            return (ticks() - this.hpet_start) * HPET_FREQ_MS + this.hpet_offset_low | 0;
        }
        else
        {
            return this.hpet_offset_low;
        }
    }

    public get_counter_high(): number
    {
        if(HPET_SUPPORT_64)
        {
            if(this.hpet_enabled)
            {
                return (ticks() - this.hpet_start) * (HPET_FREQ_MS / 0x100000000) + this.hpet_offset_high | 0;
            }
            else
            {
                return this.hpet_offset_high;
            }
        }
        else
        {
            return 0;
        }
    }

    public mmio_read(addr): number
    {
        dbg_log("Read " + h(addr, 4) + " (ctr=" + h(this.get_counter() >>> 0) + ")", LOG_HPET);

        switch(addr)
        {
            case 0:
                return 1 << 16 | HPET_NUM_COUNTERS - 1 << 8 | 0x8000 | 0x01 | HPET_SUPPORT_64 << 13;
            case 4:
                return HPET_PERIOD;

            case 0x10:
                return (this.legacy_mode ? 1 : 0) << 1 | (this.hpet_enabled ? 1 : 0);

            case 0xF0:
                return this.get_counter();

            case 0xF4:
                return this.get_counter_high();
        }

        // read from counter register
        var register = addr >> 2 & 7,
            counter = addr - 0x100 >> 5;

        if(addr < 0x100 || counter >= HPET_NUM_COUNTERS || register > 5)
        {
            dbg_log("Read reserved address: " + h(addr), LOG_HPET);
            return 0;
        }

        dbg_log("Read counter: addr=" + h(addr) + " counter=" + h(counter, 2) +
                " reg=" + h(register), LOG_HPET);

        switch(register)
        {
            case 0:
                return this.counter_config[counter << 1] & ~HPET_COUNTER_CONFIG_MASK | HPET_COUNTER_CONFIG;
            case 1:
                return this.counter_config[counter << 1 | 1];

            case 2:
                return this.counter_comparator[counter << 1];
            case 3:
                return this.counter_comparator[counter << 1 | 1];

            case 4:
            case 5:
                // TODO interrupt route register
                return 0;
        }
        throw "wat";
    }

    public mmio_write(addr, data): void
    {
        dbg_log("Write " + h(addr, 4) + ": " + h(data, 2), LOG_HPET);

        switch(addr)
        {
            case 0x10:
                dbg_log("conf: enabled=" + (data & 1) + " legacy=" + (data >> 1 & 1), LOG_HPET);

                if(((this.hpet_enabled ? 1 : 0) ^ data) & 1)
                {
                    if(data & 1)
                    {
                        // counter is enabled now, start counting now
                        this.hpet_start = ticks();
                    }
                    else
                    {
                        // counter is disabled now, save current count
                        this.hpet_offset_low = this.get_counter();
                        this.hpet_offset_high = this.get_counter_high();
                    }
                }

                this.hpet_enabled = (data & 1) === 1;
                this.legacy_mode = (data & 2) === 2;

                return;

            case 0x20:
                // writing a 1 clears bits
                this.interrupt_status &= ~data;
                return;

            case 0xF0:
                this.hpet_offset_low = data;
                return;

            case 0xF4:
                this.hpet_offset_high = data;
                return;
        }

        // read from counter register
        var register = addr >> 2 & 7,
            counter = addr - 0x100 >> 5;

        if(addr < 0x100 || counter >= HPET_NUM_COUNTERS || register > 2)
        {
            dbg_log("Write reserved address: " + h(addr) + " data=" + h(data), LOG_HPET);
            return;
        }

        dbg_log("Write counter: addr=" + h(addr) + " counter=" + h(counter, 2) +
                " reg=" + h(register) + " data=" + h(data, 2), LOG_HPET);

        switch(register)
        {
            case 0:
                this.counter_config[counter << 1] = data;
                break;
            case 1:
                //counter_config[counter << 1 | 1] = data;
                break;

            case 2:
                if(this.counter_read_acc_next)
                {
                    this.counter_accumulator[counter << 1] = data;
                    this.counter_read_acc_next = false;
                    dbg_log("Accumulator acc=" + h(data >>> 0, 8) + " ctr=" + h(counter, 2), LOG_HPET);
                }
                else
                {
                    this.counter_comparator[counter << 1] = data;

                    if(this.counter_config[counter << 1] & 1 << 6)
                    {
                        this.counter_read_acc_next = true;
                        this.counter_config[counter << 1] &= ~(1 << 6);
                    }
                }
                break;
            case 3:
                this.counter_comparator[counter << 1 | 1] = data;
                break;

            case 4:
            case 5:
                // TODO interrupt route register
        }
    }
}
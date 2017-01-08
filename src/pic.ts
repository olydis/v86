import { h, int_log2_byte } from "./lib";
import { dbg_log, dbg_assert } from "./log";
import { CPU } from "./cpu";

/** @const */
var PIC_LOG_VERBOSE = true;

/**
 * Programmable Interrupt Controller
 * http://stanislavs.org/helppc/8259.html
 */

export class PIC
{
    /**
     * all irqs off
     */
    private irq_mask = 0;

    /**
     * Bogus default value (both master and slave mapped to 0).
     * Will be initialized by the BIOS
     */
    private irq_map = 0;

    /**
     * in-service register
     * Holds interrupts that are currently being serviced
     */
    private isr = 0;

    /**
     * interrupt request register
     * Holds interrupts that have been requested
     */
    private irr = 0;

    private irq_value = 0;

    private is_master: boolean;
    private slave: any;
    private name: string;

    private expect_icw4 = false;
    private state = 0;
    private read_isr = 0;
    private auto_eoi = 1;
    private special_mask_mode = false; // formerly 0, but that made little sense from all the uses
    private elcr = 0;

    public check_irqs: () => boolean;

    constructor(private cpu: CPU, private master?: PIC)
    {
        this.is_master = this.master === undefined;
        this.slave = undefined;

        this.name = this.is_master ? "master" : "slave ";


        // Checking for callable interrupts:
        // (cpu changes interrupt flag) -> cpu.handle_irqs -> pic.check_irqs -> cpu.pic_call_irq
        // (pic changes isr/irr) -> cpu.handle_irqs -> ...

        // triggering irqs:
        // (io device has irq) -> cpu.device_raise_irq -> pic.set_irq -> cpu.handle_irqs -> (see above)

        if(this.is_master)
        {
            this.slave = new PIC(this.cpu, this);

            this.check_irqs = () =>
            {
                var enabled_irr = this.irr & this.irq_mask;

                if(!enabled_irr)
                {
                    if(PIC_LOG_VERBOSE)
                    {
                        dbg_log("master> no unmasked irrs. irr=" + h(this.irr, 2) +
                                " mask=" + h(this.irq_mask & 0xff, 2) + " isr=" + h(this.isr, 2), LOG_PIC);
                    }
                    return this.slave.check_irqs();
                }

                var irq_mask = enabled_irr & -enabled_irr;
                var special_mask = this.special_mask_mode ? this.irq_mask : -1;

                if(this.isr && (this.isr & -this.isr & special_mask) <= irq_mask)
                {
                    // wait for eoi of higher or same priority interrupt
                    dbg_log("master> higher prio: isr=" + h(this.isr, 2) +
                            " mask=" + h(this.irq_mask & 0xff, 2) + " irq=" + h(irq_mask, 2), LOG_PIC);
                    return false;
                }

                dbg_assert(irq_mask !== 0);
                var irq_number = int_log2_byte(irq_mask);
                dbg_assert(irq_mask === (1 << irq_number));

                this.irr &= ~irq_mask; // not in level mode

                if(irq_number === 2)
                {
                    // this should always return true
                    this.irq_value &= ~2;
                    var did = this.slave.check_irqs();
                    if(!did) dbg_log("Slave had irq when master irq number was 2", LOG_PIC);
                    return did;
                }

                if(!this.auto_eoi)
                {
                    this.isr |= irq_mask;
                }

                dbg_log("master handling irq " + irq_number, LOG_PIC);
                this.cpu.pic_call_irq(this.irq_map | irq_number);

                return true;
            };
        }
        else
        {
            // is slave
            this.check_irqs = () =>
            {
                var enabled_irr = this.irr & this.irq_mask;

                if(!enabled_irr)
                {
                    if(PIC_LOG_VERBOSE)
                    {
                        dbg_log("slave > no unmasked irrs. irr=" + h(this.irr, 2) +
                                " mask=" + h(this.irq_mask & 0xff, 2) + " isr=" + h(this.isr, 2), LOG_PIC);
                    }
                    return false;
                }

                var irq_mask = enabled_irr & -enabled_irr;
                var special_mask = this.special_mask_mode ? this.irq_mask : -1;

                if(this.isr && (this.isr & -this.isr & special_mask) <= irq_mask)
                {
                    // wait for eoi of higher or same priority interrupt
                    dbg_log("slave > higher prio: isr=" + h(this.isr, 2) + " irq=" + h(irq_mask, 2), LOG_PIC);
                    return false;
                }

                dbg_assert(irq_mask !== 0);
                var irq_number = int_log2_byte(irq_mask);
                dbg_assert(irq_mask === (1 << irq_number));

                this.irr &= ~irq_mask; // not in level mode

                dbg_log("slave > handling irq " + irq_number, LOG_PIC);
                this.cpu.pic_call_irq(this.irq_map | irq_number);

                this.master.clear_irq(2);

                if(this.irr)
                {
                    // tell the master we have one more
                    this.master.set_irq(2);
                }

                if(!this.auto_eoi)
                {
                    this.isr |= irq_mask;
                    this.master.isr |= 1 << 2;
                }

                return true;
            };
        }

        var io_base;
        var iobase_high;
        if(this.is_master)
        {
            io_base = 0x20;
            iobase_high = 0x4D0;
        }
        else
        {
            io_base = 0xA0;
            iobase_high = 0x4D1;
        }

        this.cpu.io.register_write(io_base, this, data_byte => this.port20_write(data_byte));
        this.cpu.io.register_read(io_base, this, () => this.port20_read());

        this.cpu.io.register_write(io_base | 1, this, data_byte => this.port21_write(data_byte));
        this.cpu.io.register_read(io_base | 1, this, () => this.port21_read());

        this.cpu.io.register_write(iobase_high, this, data_byte => this.port4D0_write(data_byte));
        this.cpu.io.register_read(iobase_high, this, () => this.port4D0_read());

        if(this.is_master)
        {
            this.set_irq = (irq_number) =>
            {
                dbg_assert(irq_number >= 0 && irq_number < 16);
                if(PIC_LOG_VERBOSE)
                {
                    dbg_log("master> set irq " + irq_number, LOG_PIC);
                }

                if(irq_number >= 8)
                {
                    this.slave.set_irq(irq_number - 8);
                    irq_number = 2;
                }

                var irq_mask = 1 << irq_number;
                if((this.irq_value & irq_mask) === 0)
                {
                    this.irr |= irq_mask & ~this.irq_value;
                    this.irq_value |= irq_mask;
                }

                this.cpu.handle_irqs();
            };

            this.clear_irq = (irq_number) =>
            {
                dbg_assert(irq_number >= 0 && irq_number < 16);
                if(PIC_LOG_VERBOSE)
                {
                    dbg_log("master> clear irq " + irq_number, LOG_PIC);
                }

                if(irq_number >= 8)
                {
                    this.slave.clear_irq(irq_number - 8);
                    return;
                }

                var irq_mask = 1 << irq_number;
                if(this.irq_value & irq_mask)
                {
                    this.irq_value &= ~irq_mask
                    this.irr &= ~irq_mask;
                }
            };
        }
        else
        {
            this.set_irq = (irq_number) =>
            {
                dbg_assert(irq_number >= 0 && irq_number < 8);
                if(PIC_LOG_VERBOSE)
                {
                    dbg_log("slave > set irq " + irq_number, LOG_PIC);
                }

                var irq_mask = 1 << irq_number;
                if((this.irq_value & irq_mask) === 0)
                {
                    this.irr |= irq_mask;
                    this.irq_value |= irq_mask;
                }
            };

            this.clear_irq = (irq_number) =>
            {
                dbg_assert(irq_number >= 0 && irq_number < 8);
                if(PIC_LOG_VERBOSE)
                {
                    dbg_log("slave > clear irq " + irq_number, LOG_PIC);
                }

                var irq_mask = 1 << irq_number;
                if(this.irq_value & irq_mask)
                {
                    this.irq_value &= ~irq_mask;
                    this.irr &= ~irq_mask;
                }
            };
        }
    }

    public dump()
    {
        dbg_log("mask: " + h(this.irq_mask & 0xFF), LOG_PIC);
        dbg_log("base: " + h(this.irq_map), LOG_PIC);
        dbg_log("requested: " + h(this.irr), LOG_PIC);
        dbg_log("serviced: " + h(this.isr), LOG_PIC);

        if(this.is_master)
        {
            this.slave.dump();
        }
    }

    public set_irq: (irq_number: number) => void;
    public clear_irq: (irq_number: number) => void;

    public port20_write(data_byte)
    {
        //dbg_log("20 write: " + h(data_byte), LOG_PIC);
        if(data_byte & 0x10) // xxxx1xxx
        {
            // icw1
            dbg_log("icw1 = " + h(data_byte), LOG_PIC);
            this.isr = 0;
            this.irr = 0;
            this.irq_mask = 0;
            this.irq_value = 0;
            this.auto_eoi = 1;

            this.expect_icw4 = (data_byte & 1) !== 0;
            this.state = 1;
        }
        else if(data_byte & 8) // xxx01xxx
        {
            // ocw3
            dbg_log("ocw3: " + h(data_byte), LOG_PIC);
            if(data_byte & 2)
            {
                this.read_isr = data_byte & 1;
            }
            if(data_byte & 4)
            {
                dbg_assert(false, "unimplemented: polling", LOG_PIC);
            }
            if(data_byte & 0x40)
            {
                this.special_mask_mode = (data_byte & 0x20) === 0x20;
                dbg_log("special mask mode: " + this.special_mask_mode, LOG_PIC);
            }
        }
        else // xxx00xxx
        {
            // ocw2
            // end of interrupt
            dbg_log("eoi: " + h(data_byte) + " (" + this.name + ")", LOG_PIC);

            var eoi_type = data_byte >> 5;

            if(eoi_type === 1)
            {
                // non-specific eoi
                this.isr &= this.isr - 1;
                dbg_log("new isr: " + h(this.isr, 2), LOG_PIC);
            }
            else if(eoi_type === 3)
            {
                // specific eoi
                this.isr &= ~(1 << (data_byte & 7));
            }
            else
            {
                dbg_log("Unknown eoi: " + h(data_byte), LOG_PIC);
                // os2 v4
                //dbg_assert(false);
                this.isr &= this.isr - 1;
            }

            this.cpu.handle_irqs();
        }
    };

    public port20_read()
    {
        if(this.read_isr)
        {
            dbg_log("read port 20h (isr): " + h(this.isr));
            return this.isr;
        }
        else
        {
            dbg_log("read port 20h (irr): " + h(this.irr));
            return this.irr;
        }
    }

    public port21_write(data_byte)
    {
        //dbg_log("21 write: " + h(data_byte), LOG_PIC);
        if(this.state === 0)
        {
            if(this.expect_icw4)
            {
                // icw4
                this.expect_icw4 = false;
                this.auto_eoi = data_byte & 2;
                dbg_log("icw4: " + h(data_byte) + " autoeoi=" + this.auto_eoi, LOG_PIC);

                if((data_byte & 1) === 0)
                {
                    dbg_assert(false, "unimplemented: not 8086 mode", LOG_PIC);
                }
            }
            else
            {
                // ocw1
                this.irq_mask = ~data_byte;

                //dbg_log("interrupt mask: " + (this.irq_mask & 0xFF).toString(2) +
                //        " (" + this.name + ")", LOG_PIC);

                this.cpu.handle_irqs();
            }
        }
        else if(this.state === 1)
        {
            // icw2
            this.irq_map = data_byte;
            dbg_log("interrupts are mapped to " + h(this.irq_map) +
                    " (" + this.name + ")", LOG_PIC);
            this.state++;
        }
        else if(this.state === 2)
        {
            // icw3
            this.state = 0;
            dbg_log("icw3: " + h(data_byte), LOG_PIC);
        }
    };

    public port21_read()
    {
        dbg_log("21h read " + h(~this.irq_mask & 0xff), LOG_PIC);
        return ~this.irq_mask & 0xFF;
    }

    public port4D0_read()
    {
        dbg_log("elcr read: " + h(this.elcr, 2), LOG_PIC);
        return this.elcr;
    }

    public port4D0_write(value)
    {
        dbg_log("elcr write: " + h(value, 2), LOG_PIC);
        // set by seabios to 00 0C (only set for pci interrupts)
        this.elcr = value;
    }

    public get_isr()
    {
        return this.isr;
    }

    public get_state()
    {
        var state = [];

        state[0] = this.irq_mask;
        state[1] = this.irq_map;
        state[2] = this.isr;
        state[3] = this.irr;
        state[4] = this.is_master;
        state[5] = this.slave;
        state[6] = this.expect_icw4;
        state[7] = this.state;
        state[8] = this.read_isr;
        state[9] = this.auto_eoi;

        return state;
    };

    public set_state(state)
    {
        this.irq_mask = state[0];
        this.irq_map = state[1];
        this.isr = state[2];
        this.irr = state[3];
        this.is_master = state[4];
        this.slave = state[5];
        this.expect_icw4 = state[6];
        this.state = state[7];
        this.read_isr = state[8];
        this.auto_eoi = state[9];
    };

}
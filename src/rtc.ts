import { h } from "./lib";
import { CPU } from "./cpu";
import { dbg_log, dbg_assert } from "./log";

/**
 * RTC (real time clock) and CMOS
 */
export class RTC
{
    private cmos_index = 0;
    private cmos_data = new Uint8Array(128);

    // used for cmos entries
    private rtc_time = Date.now();
    private last_update = this.rtc_time;

    // used for periodic interrupt
    private next_interrupt = 0;

    private periodic_interrupt = false;

    // corresponds to default value for cmos_a
    private periodic_interrupt_time = 1000 / 1024;

    private cmos_a = 0x26;
    private cmos_b = 2;
    private cmos_c = 0;

    private nmi_disabled = 0;

    constructor(private readonly cpu: CPU)
    {
        cpu.io.register_write(0x70, this, (out_byte) =>
        {
            this.cmos_index = out_byte & 0x7F;
            this.nmi_disabled = out_byte >> 7;
        });

        cpu.io.register_write(0x71, this, (data_byte) => this.cmos_port_write(data_byte));
        cpu.io.register_read(0x71, this, () => this.cmos_port_read());
    }

    public get_state()
    {
        var state = [];

        state[0] = this.cmos_index;
        state[1] = this.cmos_data;
        state[2] = this.rtc_time;
        state[3] = this.last_update;
        state[4] = this.next_interrupt;

        state[6] = this.periodic_interrupt;
        state[7] = this.periodic_interrupt_time;
        state[8] = this.cmos_a;
        state[9] = this.cmos_b;
        state[10] = this.cmos_c;
        state[11] = this.nmi_disabled;

        return state;
    };

    public set_state(state)
    {
        this.cmos_index = state[0];
        this.cmos_data = state[1];
        this.rtc_time = state[2];
        this.last_update = state[3];
        this.next_interrupt = state[4];

        this.periodic_interrupt = state[6];
        this.periodic_interrupt_time = state[7];
        this.cmos_a = state[8];
        this.cmos_b = state[9];
        this.cmos_c = state[10];
        this.nmi_disabled = state[11];
    };

    public timer(time, legacy_mode)
    {
        time = Date.now(); // XXX
        this.rtc_time += time - this.last_update;
        this.last_update = time;

        if(this.periodic_interrupt && this.next_interrupt < time)
        {
            this.cpu.device_raise_irq(8);
            this.cmos_c |= 1 << 6 | 1 << 7;

            this.next_interrupt += this.periodic_interrupt_time *
                    Math.ceil((time - this.next_interrupt) / this.periodic_interrupt_time);

            return Math.max(0, time - this.next_interrupt);
        }

        return 100;
    };

    public bcd_pack(n)
    {
        var i = 0,
            result = 0,
            digit;

        while(n)
        {
            digit = n % 10;

            result |= digit << (4 * i);
            i++;
            n = (n - digit) / 10;
        }

        return result;
    };

    public encode_time(t)
    {
        if(this.cmos_b & 4)
        {
            // binary mode
            return t;
        }
        else
        {
            return this.bcd_pack(t);
        }
    };

    // TODO
    // - interrupt on update
    // - countdown
    // - letting bios/os set values
    // (none of these are used by seabios or the OSes we're
    // currently testing)
    public cmos_port_read()
    {
        var index = this.cmos_index;

        //this.cmos_index = 0xD;

        switch(index)
        {
            case CMOS_RTC_SECONDS:
                return this.encode_time(new Date(this.rtc_time).getUTCSeconds());
            case CMOS_RTC_MINUTES:
                return this.encode_time(new Date(this.rtc_time).getUTCMinutes());
            case CMOS_RTC_HOURS:
                // TODO: 12 hour mode
                return this.encode_time(new Date(this.rtc_time).getUTCHours());
            case CMOS_RTC_DAY_MONTH:
                return this.encode_time(new Date(this.rtc_time).getUTCDate());
            case CMOS_RTC_MONTH:
                return this.encode_time(new Date(this.rtc_time).getUTCMonth() + 1);
            case CMOS_RTC_YEAR:
                return this.encode_time(new Date(this.rtc_time).getUTCFullYear() % 100);

            case CMOS_STATUS_A:
                return this.cmos_a;
            case CMOS_STATUS_B:
                //dbg_log("cmos read from index " + h(index));
                return this.cmos_b;

            case CMOS_STATUS_C:
                // It is important to know that upon a IRQ 8, Status Register C
                // will contain a bitmask telling which interrupt happened.
                // What is important is that if register C is not read after an
                // IRQ 8, then the interrupt will not happen again.
                this.cpu.device_lower_irq(8);

                dbg_log("cmos reg C read", LOG_RTC);
                // Missing IRQF flag
                //return cmos_b & 0x70;
                var c = this.cmos_c;

                this.cmos_c &= ~0xF0;

                return c;

            case CMOS_STATUS_D:
                return 0xFF;

            case CMOS_CENTURY:
                return this.encode_time(new Date(this.rtc_time).getUTCFullYear() / 100 | 0);

            default:
                dbg_log("cmos read from index " + h(index), LOG_RTC);
                return this.cmos_data[this.cmos_index];
        }
    };

    public cmos_port_write(data_byte)
    {
        switch(this.cmos_index)
        {
            case 0xA:
                this.cmos_a = data_byte & 0x7F;
                this.periodic_interrupt_time = 1000 / (32768 >> (this.cmos_a & 0xF) - 1);

                dbg_log("Periodic interrupt, a=" + h(this.cmos_a, 2) + " t=" + this.periodic_interrupt_time , LOG_RTC);
                break;
            case 0xB:
                this.cmos_b = data_byte;
                if(this.cmos_b & 0x40)
                {
                    this.next_interrupt = Date.now();
                }

                if(this.cmos_b & 0x20) dbg_log("Unimplemented: alarm interrupt", LOG_RTC);
                if(this.cmos_b & 0x10) dbg_log("Unimplemented: updated interrupt", LOG_RTC);

                dbg_log("cmos b=" + h(this.cmos_b, 2), LOG_RTC);
                break;
            default:
                dbg_log("cmos write index " + h(this.cmos_index) + ": " + h(data_byte), LOG_RTC);
        }

        this.periodic_interrupt = (this.cmos_b & 0x40) === 0x40 && (this.cmos_a & 0xF) > 0;
    };

    /**
     * @param {number} index
     */
    public cmos_read(index)
    {
        dbg_assert(index < 128);
        return this.cmos_data[index];
    };

    /**
     * @param {number} index
     * @param {number} value
     */
    public cmos_write(index, value)
    {
        dbg_log("cmos " + h(index) + " <- " + h(value), LOG_RTC);
        dbg_assert(index < 128);
        this.cmos_data[index] = value;
    };
}
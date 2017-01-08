import { h } from "./lib";
import { CPU } from "./cpu";
import { dbg_log, dbg_assert } from "./log";

export class DMA
{
    private channel_addr = new Int32Array(4);
    private channel_count = new Int32Array(4);

    private lsb_msb_flipflop = 0;

    private readonly cpu: CPU;

    constructor(cpu: CPU)
    {
        this.cpu = cpu;

        var io = cpu.io;
        io.register_write(0x04, this, this.port_write.bind(this, 0x04));
        io.register_write(0x05, this, this.port_write.bind(this, 0x05));
        io.register_write(0x0A, this, this.portA_write);
        io.register_write(0x0B, this, this.portB_write);
        io.register_write(0x0C, this, this.portC_write);
        io.register_write(0x81, this, this.port81_write);
    }

    public get_state(): any[]
    {
        return [
            this.channel_addr,
            this.channel_count,
            this.lsb_msb_flipflop,
        ];
    }

    public set_state(state): void
    {
        this.channel_addr = state[0];
        this.channel_count = state[1];
        this.lsb_msb_flipflop = state[2];
    }

    public port_write(port, data_byte): void
    {
        dbg_log("port " + port + " write " + data_byte, LOG_DMA);

        if(port < 8)
        {
            var channel = port >> 1;

            if(port & 1)
            {
                this.channel_count[channel] = this.flipflop_get(this.channel_count[channel], data_byte);
            }
            else
            {
                this.channel_addr[channel] = this.flipflop_get(this.channel_addr[channel], data_byte);
            }
        }
    }

    public port_read(port): number
    {
        if(port < 8)
        {
            var channel = port >> 1;

            if(port & 1)
            {
                return this.channel_count[channel];
            }
            else
            {
                // Bug?
                return this.channel_addr[channel];
            }
        }
        else
        {
            dbg_log("port " + h(port) + " read", LOG_DMA);
            return null;
        }
    }

    public portA_write(data_byte): void
    {
        dbg_log("port A write: " + h(data_byte), LOG_DMA);
    }

    public portB_write(data_byte): void
    {
        dbg_log("port B write: " + h(data_byte), LOG_DMA);
    }

    public portC_write(data_byte): void
    {
        this.lsb_msb_flipflop = 0;
    }

    public port81_write(data_byte): void
    {
        this.channel_addr[2] = this.channel_addr[2] & 0xFFFF | data_byte << 16;
    }

    // read data, write to memory
    public do_read(buffer, start, len, channel, fn): void
    {
        var read_count = this.channel_count[channel] + 1,
            addr = this.channel_addr[channel];

        dbg_log("DMA write channel " + channel, LOG_DMA);
        dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);

        if(len < read_count)
        {
            dbg_log("DMA should read more than provided: " + h(len) + " " + h(read_count), LOG_DMA);
        }

        if(start + read_count > buffer.byteLength)
        {
            dbg_log("DMA read outside of buffer", LOG_DMA);
            fn(true);
        }
        else
        {
            var cpu = this.cpu;
            this.channel_addr[channel] += read_count;

            buffer.get(start, read_count, function(data)
            {
                cpu.write_blob(data, addr);
                fn(false);
            });
        }
    }

    // write data, read memory
    public do_write(buffer, start, len, channel, fn): void
    {
        var read_count = this.channel_count[channel],
            addr = this.channel_addr[channel];

        dbg_log("DMA write channel " + channel, LOG_DMA);
        dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);

        if(len < read_count)
        {
            dbg_log("DMA should read more than provided", LOG_DMA);
        }

        if(start + read_count > buffer.byteLength)
        {
            dbg_log("DMA write outside of buffer", LOG_DMA);
            fn(true);
        }
        else
        {
            this.channel_addr[channel] += read_count;

            buffer.set(start,
                    this.cpu.mem8.subarray(addr, addr + read_count + 1),
                    function() {
                        fn(false);
                    }
                );
        }
    }

    public flipflop_get(old_dword, new_byte): number
    {
        this.lsb_msb_flipflop ^= 1;

        if(this.lsb_msb_flipflop)
        {
            // low byte
            return old_dword & ~0xFF | new_byte;
        }
        else
        {
            // high byte
            return old_dword & ~0xFF00 | new_byte << 8;
        }
    }
}
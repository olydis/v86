import { h } from "./lib";
import { dbg_log, dbg_assert } from "./log";
import { IO } from "./io";
import { CPU } from "./cpu";
import { DMA } from "./dma";

export class FloppyController
{
    private readonly io: IO;
    private readonly cpu: CPU;
    private readonly dma: DMA;

    private bytes_expecting = 0;
    private receiving_command = new Uint8Array(10);
    private receiving_index = 0;
    private next_command: any = null;

    private response_data = new Uint8Array(10);
    private response_index = 0;
    private response_length = 0;

    private floppy_size = 0;

    private readonly fda_image: any;
    private readonly fdb_image: any;


    private status_reg0 = 0;
    private status_reg1 = 0;
    private status_reg2 = 0;
    private drive = 0;

    private last_cylinder = 0;
    private last_head = 0;
    private last_sector = 1;

    // this should actually be write-only ... but people read it anyway
    private dor = 0;

    private sectors_per_track: number;
    private number_of_heads: number;
    private number_of_cylinders: number;

    constructor(cpu: CPU, fda_image, fdb_image)
    {
        this.io = cpu.io;
        this.cpu = cpu;
        this.dma = cpu.devices.dma;

        this.fda_image = fda_image;
        this.fdb_image = fdb_image;

        if(!fda_image)
        {
            // Needed for CD emulation provided by seabios
            cpu.devices.rtc.cmos_write(CMOS_FLOPPY_DRIVE_TYPE, 4 << 4);

            this.sectors_per_track = 0;
            this.number_of_heads = 0;
            this.number_of_cylinders = 0;

            this.floppy_size = 0;
        }
        else
        {
            this.floppy_size = fda_image.byteLength;

            var floppy_types = {
                160  : { type: 1, tracks: 40, sectors: 8 , heads: 1 },
                180  : { type: 1, tracks: 40, sectors: 9 , heads: 1 },
                200  : { type: 1, tracks: 40, sectors: 10, heads: 1 },
                320  : { type: 1, tracks: 40, sectors: 8 , heads: 2 },
                360  : { type: 1, tracks: 40, sectors: 9 , heads: 2 },
                400  : { type: 1, tracks: 40, sectors: 10, heads: 2 },
                720  : { type: 3, tracks: 80, sectors: 9 , heads: 2 },
                1200 : { type: 2, tracks: 80, sectors: 15, heads: 2 },
                1440 : { type: 4, tracks: 80, sectors: 18, heads: 2 },
                1722 : { type: 5, tracks: 82, sectors: 21, heads: 2 },
                2880 : { type: 5, tracks: 80, sectors: 36, heads: 2 },
            };

            var number_of_cylinders,
                sectors_per_track,
                number_of_heads,
                floppy_type = floppy_types[this.floppy_size >> 10];

            if(floppy_type && (this.floppy_size & 0x3FF) === 0)
            {
                cpu.devices.rtc.cmos_write(CMOS_FLOPPY_DRIVE_TYPE, floppy_type.type << 4);

                sectors_per_track = floppy_type.sectors;
                number_of_heads = floppy_type.heads;
                number_of_cylinders = floppy_type.tracks;
            }
            else
            {
                throw "Unknown floppy size: " + h(fda_image.byteLength);
            }

            this.sectors_per_track = sectors_per_track;
            this.number_of_heads = number_of_heads;
            this.number_of_cylinders = number_of_cylinders;
        }

        this.io.register_read(0x3F0, this, () => this.port3F0_read());
        this.io.register_read(0x3F2, this, () => this.port3F2_read());
        this.io.register_read(0x3F4, this, () => this.port3F4_read());
        this.io.register_read(0x3F5, this, () => this.port3F5_read());
        this.io.register_read(0x3F7, this, () => this.port3F7_read());

        this.io.register_write(0x3F2, this, (data_byte) => this.port3F2_write(data_byte));
        this.io.register_write(0x3F5, this, (data_byte) => this.port3F5_write(data_byte));
    }

    public get_state(): any
    {
        var state = [];

        state[0] = this.bytes_expecting;
        state[1] = this.receiving_command;
        state[2] = this.receiving_index;
        //state[3] = this.next_command;
        state[4] = this.response_data;
        state[5] = this.response_index;
        state[6] = this.response_length;
        state[7] = this.floppy_size;
        state[8] = this.status_reg0;
        state[9] = this.status_reg1;
        state[10] = this.status_reg2;
        state[11] = this.drive;
        state[12] = this.last_cylinder;
        state[13] = this.last_head;
        state[14] = this.last_sector;
        state[15] = this.dor;
        state[16] = this.sectors_per_track;
        state[17] = this.number_of_heads;
        state[18] = this.number_of_cylinders;

        return state;
    }

    public set_state(state): void
    {
        this.bytes_expecting = state[0];
        this.receiving_command = state[1];
        this.receiving_index = state[2];
        this.next_command = state[3];
        this.response_data = state[4];
        this.response_index = state[5];
        this.response_length = state[6];
        this.floppy_size = state[7];
        this.status_reg0 = state[8];
        this.status_reg1 = state[9];
        this.status_reg2 = state[10];
        this.drive = state[11];
        this.last_cylinder = state[12];
        this.last_head = state[13];
        this.last_sector = state[14];
        this.dor = state[15];
        this.sectors_per_track = state[16];
        this.number_of_heads = state[17];
        this.number_of_cylinders = state[18];
    }

    public port3F0_read(): number
    {
        dbg_log("3F0 read", LOG_FLOPPY);

        return 0;
    }

    public port3F4_read(): number
    {
        dbg_log("3F4 read", LOG_FLOPPY);

        var return_byte = 0x80;

        if(this.response_index < this.response_length)
        {
            return_byte |= 0x40 | 0x10;
        }

        if((this.dor & 8) === 0)
        {
            return_byte |= 0x20;
        }

        return return_byte;
    };

    public port3F7_read(): number
    {
        dbg_log("3F7 read", LOG_FLOPPY);
        return 0x00;
    }

    public port3F5_read(): number
    {
        if(this.response_index < this.response_length)
        {
            dbg_log("3F5 read: " + this.response_data[this.response_index], LOG_FLOPPY);
            this.cpu.device_lower_irq(6);
            return this.response_data[this.response_index++];
        }
        else
        {
            dbg_log("3F5 read, empty", LOG_FLOPPY);
            return 0xFF;
        }
    }

    public port3F5_write(reg_byte): void
    {
        if(!this.fda_image) return;

        dbg_log("3F5 write " + h(reg_byte), LOG_FLOPPY);

        if(this.bytes_expecting > 0)
        {
            this.receiving_command[this.receiving_index++] = reg_byte;

            this.bytes_expecting--;

            if(this.bytes_expecting === 0)
            {
                if(DEBUG)
                {
                    var log = "3F5 command received: ";
                    for(var i = 0; i < this.receiving_index; i++)
                        log += h(this.receiving_command[i]) + " ";
                    dbg_log(log, LOG_FLOPPY);
                }

                this.next_command(this.receiving_command);
            }
        }
        else
        {
            switch(reg_byte)
            {
                // TODO
                //case 2:
                    //this.next_command = read_complete_track;
                    //this.bytes_expecting = 8;
                    //break;
                case 0x03:
                    this.next_command = this.fix_drive_data;
                    this.bytes_expecting = 2;
                    break;
                case 0x04:
                    this.next_command = this.check_drive_status;
                    this.bytes_expecting = 1;
                    break;
                case 0x05:
                case 0xC5:
                    this.next_command = (args) => this.do_sector(true, args);
                    this.bytes_expecting = 8;
                    break;
                case 0xE6:
                    this.next_command= (args) => this.do_sector(false, args);
                    this.bytes_expecting = 8;
                    break;
                case 0x07:
                    this.next_command = this.calibrate;
                    this.bytes_expecting = 1;
                    break;
                case 0x08:
                    this.check_interrupt_status();
                    break;
                case 0x4A:
                    this.next_command = this.read_sector_id;
                    this.bytes_expecting = 1;
                    break;
                case 0x0F:
                    this.bytes_expecting = 2;
                    this.next_command = this.seek;
                    break;
                case 0x0E:
                    // dump regs
                    dbg_log("dump registers", LOG_FLOPPY);
                    this.response_data[0] = 0x80;
                    this.response_index = 0;
                    this.response_length = 1;

                    this.bytes_expecting = 0;
                    break;

                default:
                    dbg_assert(false, "Unimplemented floppy command call " + h(reg_byte));
            }

            this.receiving_index = 0;
        }
    }

    public port3F2_read(): any
    {
        dbg_log("read 3F2: DOR", LOG_FLOPPY);
        return this.dor;
    }

    public port3F2_write(value): void
    {
        if((value & 4) === 4 && (this.dor & 4) === 0)
        {
            // reset
            this.cpu.device_raise_irq(6);
        }

        dbg_log("start motors: " + h(value >> 4), LOG_FLOPPY);
        dbg_log("enable dma: " + !!(value & 8), LOG_FLOPPY);
        dbg_log("reset fdc: " + !!(value & 4), LOG_FLOPPY);
        dbg_log("drive select: " + (value & 3), LOG_FLOPPY);
        dbg_log("DOR = " + h(value), LOG_FLOPPY);

        this.dor = value;
    }

    public check_drive_status(args): void
    {
        dbg_log("check drive status", LOG_FLOPPY);

        this.response_index = 0;
        this.response_length = 1;
        this.response_data[0] = 1 << 5;
    }

    public seek(args): void
    {
        dbg_log("seek", LOG_FLOPPY);
        dbg_assert((args[0] & 3) === 0, "Unhandled seek drive");

        this.last_cylinder = args[1];
        this.last_head = args[0] >> 2 & 1;

        this.raise_irq();
    }

    public calibrate(args): void
    {
        dbg_log("floppy calibrate", LOG_FLOPPY);

        this.raise_irq();
    }

    public check_interrupt_status(): void
    {
        // do not trigger an interrupt here
        dbg_log("floppy check interrupt status", LOG_FLOPPY);

        this.response_index = 0;
        this.response_length = 2;

        this.response_data[0] = 1 << 5;
        this.response_data[1] = this.last_cylinder;
    }

    public do_sector(is_write, args): void
    {
        var head = args[2],
            cylinder = args[1],
            sector = args[3],
            sector_size = 128 << args[4],
            read_count = args[5] - args[3] + 1,

            read_offset = ((head + this.number_of_heads * cylinder) * this.sectors_per_track + sector - 1) * sector_size;

        dbg_log("Floppy " + (is_write ? "Write" : "Read"), LOG_FLOPPY);
        dbg_log("from " + h(read_offset) + " length " + h(read_count * sector_size), LOG_FLOPPY);
        dbg_log(cylinder + " / " + head + " / " + sector, LOG_FLOPPY);

        if(!args[4])
        {
            dbg_log("FDC: sector count is zero, use data length instead", LOG_FLOPPY);
        }

        if(!this.fda_image)
        {
            return;
        }

        if(is_write)
        {
            this.dma.do_write(this.fda_image, read_offset, read_count * sector_size, 2, this.done.bind(this, args, cylinder, head, sector));
        }
        else
        {
            this.dma.do_read(this.fda_image, read_offset, read_count * sector_size, 2, this.done.bind(this, args, cylinder, head, sector));
        }
    }

    public done(args, cylinder, head, sector, error): void
    {
        if(error)
        {
            // TODO: Set appropriate bits
            return;
        }

        sector++;

        if(sector > this.sectors_per_track)
        {
            sector = 1;
            head++;

            if(head >= this.number_of_heads)
            {
                head = 0;
                cylinder++;
            }
        }

        this.last_cylinder = cylinder;
        this.last_head = head;
        this.last_sector = sector;

        this.response_index = 0;
        this.response_length = 7;

        this.response_data[0] = head << 2 | 0x20;
        this.response_data[1] = 0;
        this.response_data[2] = 0;
        this.response_data[3] = cylinder;
        this.response_data[4] = head;
        this.response_data[5] = sector;
        this.response_data[6] = args[4];

        this.raise_irq();
    }

    public fix_drive_data(args): void
    {
        dbg_log("floppy fix drive data " + args, LOG_FLOPPY);
    }

    public read_sector_id(args): void
    {
        dbg_log("floppy read sector id " + args, LOG_FLOPPY);

        this.response_index = 0;
        this.response_length = 7;

        this.response_data[0] = 0;
        this.response_data[1] = 0;
        this.response_data[2] = 0;
        this.response_data[3] = 0;
        this.response_data[4] = 0;
        this.response_data[5] = 0;
        this.response_data[6] = 0;

        this.raise_irq();
    }

    public raise_irq(): void
    {
        if(this.dor & 8)
        {
            this.cpu.device_raise_irq(6);
        }
    }
}
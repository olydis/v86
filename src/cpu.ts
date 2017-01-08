import { h, v86util } from "./lib";
import { table16, table32, table0F_16, table0F_32 } from "./instructions";
import { Debug } from "./debug";
import { ACPI } from "./acpi";
import { APIC } from "./apic";
import { DMA } from "./dma";
import { FloppyController } from "./floppy";
import { FPU } from "./fpu";
import { HPET } from "./hpet";
import { IDEDevice } from "./ide";
import { IO } from "./io";
import { Ne2k } from "./ne2k";
import { PCI } from "./pci";
import { PIC } from "./pic";
import { PIT } from "./pit";
import { PS2 } from "./ps2";
import { RTC } from "./rtc";
import { UART } from "./uart";
import { VGAScreen } from "./vga";
import { VirtIO } from "./virtio";
import { v86 } from "./main";
import { dbg_log, dbg_assert, dbg_trace } from "./log";

import * as State from "./state";
import * as StringX from "./string";
import { StateLoadError } from "./state";

interface Devices
{
    fdc?: FloppyController;
    cdrom?: IDEDevice;
    virtio?: VirtIO;
    rtc?: RTC;
    pci?: PCI;
    dma?: DMA;
    hpet?: HPET;
    apic?: APIC;
    acpi?: ACPI;
    vga?: VGAScreen;
    ps2?: PS2;
    uart?: UART;
    hda?: IDEDevice;
    hdb?: IDEDevice;
    pit?: PIT;
    net?: Ne2k;
    pic?: PIC;
}

// Resources:
// https://pdos.csail.mit.edu/6.828/2006/readings/i386/toc.htm
// https://www-ssl.intel.com/content/www/us/en/processors/architectures-software-developer-manuals.html
// http://ref.x86asm.net/geek32.html

export class CPU
{
    public memory_size = 0;

    // Note: Currently unused (degrades performance and not required by any OS that we support)
    private a20_enabled = true;

    public mem8 = new Uint8Array(0);
    public mem16 = new Uint16Array(this.mem8.buffer);
    public mem32s = new Int32Array(this.mem8.buffer);

    private mem_page_infos: any = undefined;

    private segment_is_null = new Uint8Array(0);
    public segment_offsets = new Int32Array(0);
    public segment_limits = new Uint32Array(0);
    //private segment_infos = [];

    /**
     * Translation Lookaside Buffer
     */
    private readonly tlb_data = new Int32Array(1 << 20);

    /**
     * Information about which pages are cached in the tlb.
     * By bit:
     *   0 system, read
     *   1 system, write
     *   2 user, read
     *   3 user, write
     */
    private readonly tlb_info = new Uint8Array(1 << 20);

    /**
     * Same as tlb_info, except it only contains global pages
     */
    private readonly tlb_info_global = new Uint8Array(1 << 20);

    /**
     * Wheter or not in protected mode
     */
    public protected_mode = false;

    /**
     * interrupt descriptor table
     */
    public idtr_size = 0;
    public idtr_offset = 0;

    public gdtr_size = 0;
    public gdtr_offset = 0;

    /*
    * whether or not a page fault occured
    */
    private page_fault = false;

    public cr = new Int32Array(8);

    // current privilege level
    public cpl = 0;

    // if false, pages are 4 KiB, else 4 Mib
    private page_size_extensions = 0;

    // current operand/address/stack size
    public is_32 = false;
    public stack_size_32 = false;

    /**
     * Was the last instruction a hlt?
     */
    private in_hlt = false;

    public devices: Devices = {
            vga: null,
            ps2: null,
        };

    private last_virt_eip = 0;
    private eip_phys = 0;
    private last_virt_esp = 0;
    private esp_phys = 0;
    private sysenter_cs = 0;
    private sysenter_esp = 0;
    private sysenter_eip = 0;
    private prefixes = 0;
    public flags = 0;

    /**
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     */
    public flags_changed = 0;

    /**
     * the last 2 operators and the result and size of the last arithmetic operation
     */
    private last_op1 = 0;
    private last_op2 = 0;
    private last_op_size = 0;
    private last_add_result = 0;
    private last_result = 0;

    private mul32_result = new Int32Array(2);
    private div32_result = new Float64Array(2);

    private tsc_offset = 0;
    private modrm_byte = 0;
    private phys_addr = 0;
    private phys_addr_high = 0;

    private table = [];

    // paging enabled
    public paging = false;

    public instruction_pointer = 0;
    public previous_ip = 0;

    // managed in io.js
    public readonly memory_map_read8 = [];
    public readonly memory_map_write8 = [];
    public readonly memory_map_read32 = [];
    public readonly memory_map_write32 = [];

    private readonly bios: {main: ArrayBuffer, vga: ArrayBuffer} = { main: null, vga: null };

    private timestamp_counter = 0;

    // registers
    private reg32s = new Int32Array(8);
    public reg32 = new Uint32Array(this.reg32s.buffer);
    private reg16s = new Int16Array(this.reg32s.buffer);
    public reg16 = new Uint16Array(this.reg32s.buffer);
    private reg8s = new Int8Array(this.reg32s.buffer);
    private reg8 = new Uint8Array(this.reg32s.buffer);

    // segment registers, tr and ldtr
    public sreg = new Uint16Array(8);

    // debug registers
    private dreg = new Int32Array(8);

    // dynamic instruction translator
    private translator = undefined;

    public io = undefined;
    private fpu = undefined;

    private debug: Debug;

    constructor()
    {
        this.cr[0] = 0;
        this.cr[2] = 0;
        this.cr[3] = 0;
        this.cr[4] = 0;

        dbg_assert(!!(table16 && table32));
        dbg_assert(!!(table0F_16 && table0F_32));

        this.update_operand_size();

        this.tsc_offset = v86.microtick();

        this.debug_init();

        this.init2();

        //Object.seal(this);
    }

    public get_state(): any
    {
        var state = [];

        state[0] = this.memory_size;
        state[1] = this.segment_is_null;
        state[2] = this.segment_offsets;
        state[3] = this.segment_limits;
        state[4] = this.protected_mode;
        state[5] = this.idtr_offset;
        state[6] = this.idtr_size;
        state[7] = this.gdtr_offset;
        state[8] = this.gdtr_size;
        state[9] = this.page_fault;
        state[10] = this.cr;
        state[11] = this.cpl;
        state[12] = this.page_size_extensions;
        state[13] = this.is_32;

        state[16] = this.stack_size_32;
        state[17] = this.in_hlt;
        state[18] = this.last_virt_eip;
        state[19] = this.eip_phys;
        state[20] = this.last_virt_esp;
        state[21] = this.esp_phys;
        state[22] = this.sysenter_cs;
        state[23] = this.sysenter_eip;
        state[24] = this.sysenter_esp;

        state[26] = this.flags;
        state[27] = this.flags_changed;
        state[28] = this.last_op1;
        state[29] = this.last_op2;
        state[30] = this.last_op_size;
        state[31] = this.last_add_result;
        state[32] = this.modrm_byte;

        state[36] = this.paging;
        state[37] = this.instruction_pointer;
        state[38] = this.previous_ip;
        state[39] = this.reg32s;
        state[40] = this.sreg;
        state[41] = this.dreg;
        state[42] = this.mem8;
        state[43] = this.fpu;

        state[45] = this.devices.virtio;
        //state[46] = this.devices.apic;
        state[47] = this.devices.rtc;
        state[48] = this.devices.pci;
        state[49] = this.devices.dma;
        //state[50] = this.devices.acpi;
        state[51] = this.devices.hpet;
        state[52] = this.devices.vga;
        state[53] = this.devices.ps2;
        state[54] = this.devices.uart;
        state[55] = this.devices.fdc;
        state[56] = this.devices.cdrom;
        state[57] = this.devices.hda;
        state[58] = this.devices.pit;
        state[59] = this.devices.net;
        state[60] = this.devices.pic;

        state[61] = this.a20_enabled;

        return state;
    }

    public set_state(state): void
    {
        this.memory_size = state[0];
        this.segment_is_null = state[1];
        this.segment_offsets = state[2];
        this.segment_limits = state[3];
        this.protected_mode = state[4];
        this.idtr_offset = state[5];
        this.idtr_size = state[6];
        this.gdtr_offset = state[7];
        this.gdtr_size = state[8];
        this.page_fault = state[9];
        this.cr = state[10];
        this.cpl = state[11];
        this.page_size_extensions = state[12];
        this.is_32 = state[13];

        this.stack_size_32 = state[16];

        this.in_hlt = state[17];
        this.last_virt_eip = state[18];
        this.eip_phys = state[19];
        this.last_virt_esp = state[20];
        this.esp_phys = state[21];
        this.sysenter_cs = state[22];
        this.sysenter_eip = state[23];
        this.sysenter_esp = state[24];

        this.flags = state[26];
        this.flags_changed = state[27];
        this.last_op1 = state[28];
        this.last_op2 = state[29];
        this.last_op_size = state[30];
        this.last_add_result = state[31];
        this.modrm_byte = state[32];

        this.paging = state[36];
        this.instruction_pointer = state[37];
        this.previous_ip = state[38];
        this.reg32s = state[39];
        this.sreg = state[40];
        this.dreg = state[41];
        this.mem8 = state[42];
        this.fpu = state[43];

        this.devices.virtio = state[45];
        //this.devices.apic = state[46];
        this.devices.rtc = state[47];
        this.devices.pci = state[48];
        this.devices.dma = state[49];
        //this.devices.acpi = state[50];
        this.devices.hpet = state[51];
        this.devices.vga = state[52];
        this.devices.ps2 = state[53];
        this.devices.uart = state[54];
        this.devices.fdc = state[55];
        this.devices.cdrom = state[56];
        this.devices.hda = state[57];
        this.devices.pit = state[58];
        this.devices.net = state[59];
        this.devices.pic = state[60];

        this.a20_enabled = state[61];

        this.mem16 = new Uint16Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 1);
        this.mem32s = new Int32Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 2);


        this.full_clear_tlb();
        // tsc_offset?

        this.reg32 = new Uint32Array(this.reg32s.buffer);
        this.reg16s = new Int16Array(this.reg32s.buffer);
        this.reg16 = new Uint16Array(this.reg32s.buffer);
        this.reg8s = new Int8Array(this.reg32s.buffer);
        this.reg8 = new Uint8Array(this.reg32s.buffer);

        this.update_operand_size();
    }


    /**
     * time in ms until this method should becalled again
     */
    public main_run(): number
    {
        if(this.in_hlt)
        {
            //if(false)
            //{
            //    var _t = this.hlt_loop();
            //    var t = 0;
            //}
            //else
            {
                var t = this.hlt_loop();
            }

            if(this.in_hlt)
            {
                return t;
            }
        }

        //var t = performance.now();
        this.do_run();
        //t = performance.now() - t;
        //if(t < TIME_PER_FRAME)
        //{
        //    var was_hlt = this.in_hlt;
        //    dbg_assert(was_hlt);
        //    var now = performance.now();
        //    var pit_time = this.devices.pit.timer(now, false);
        //    var rtc_time = this.devices.rtc.timer(now, false);
        //    this.handle_irqs();
        //    dbg_log("short cycle " + was_hlt + " " + this.in_hlt + " " + t);
        //}
        return 0;
    }

    public exception_cleanup(e): void
    {
        if(e === MAGIC_CPU_EXCEPTION)
        {
            // A legit CPU exception (for instance, a page fault happened)
            // call_interrupt_vector has already been called at this point,
            // so we just need to reset some state

            this.page_fault = false;

            // restore state from prefixes
            this.clear_prefixes();
        }
        else
        {
            console.log(e);
            console.log(e.stack);
            //var e = new Error(e.message);
            //Error.captureStackTrace && Error.captureStackTrace(e);
            throw e;
        }
    }

    public reboot_internal(): void
    {
        this.reset();
        this.load_bios();

        throw MAGIC_CPU_EXCEPTION;
    }

    public reset(): void
    {
        this.a20_enabled = true;

        this.segment_is_null = new Uint8Array(8);
        this.segment_limits = new Uint32Array(8);
        //this.segment_infos = new Uint32Array(8);
        this.segment_offsets = new Int32Array(8);

        this.full_clear_tlb();

        this.reg32s = new Int32Array(8);
        this.reg32 = new Uint32Array(this.reg32s.buffer);
        this.reg16s = new Int16Array(this.reg32s.buffer);
        this.reg16 = new Uint16Array(this.reg32s.buffer);
        this.reg8s = new Int8Array(this.reg32s.buffer);
        this.reg8 = new Uint8Array(this.reg32s.buffer);
        this.sreg = new Uint16Array(8);
        this.dreg = new Int32Array(8);
        this.protected_mode = false;

        // http://www.sandpile.org/x86/initial.htm
        this.idtr_size = 0;
        this.idtr_offset = 0;

        this.gdtr_size = 0;
        this.gdtr_offset = 0;

        this.page_fault = false;
        this.cr[0] = 1 << 30 | 1 << 29 | 1 << 4;
        this.cr[2] = 0;
        this.cr[3] = 0;
        this.cr[4] = 0;
        this.dreg[6] = 0xFFFF0FF0|0;
        this.dreg[7] = 0x400;
        this.cpl = 0;
        this.paging = false;
        this.page_size_extensions = 0;
        this.is_32 = false;
        this.stack_size_32 = false;

        this.paging_changed();

        this.update_operand_size();

        this.timestamp_counter = 0;
        this.previous_ip = 0;
        this.in_hlt = false;

        this.sysenter_cs = 0;
        this.sysenter_esp = 0;
        this.sysenter_eip = 0;

        this.flags = flags_default;
        this.flags_changed = 0;

        this.last_result = 0;
        this.last_add_result = 0;
        this.last_op1 = 0;
        this.last_op2 = 0;
        this.last_op_size = 0;

        this.tsc_offset = v86.microtick();

        this.instruction_pointer = 0xFFFF0;
        this.switch_cs_real_mode(0xF000);

        this.switch_seg(reg_ss, 0x30);
        this.reg16[reg_sp] = 0x100;

        if(this.devices.virtio)
        {
            this.devices.virtio.reset();
        }
    }

    /** @export */
    public create_memory(size): void
    {
        if(size < 1024 * 1024)
        {
            size = 1024 * 1024;
        }
        else if((size | 0) < 0)
        {
            size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
        }

        size = ((size - 1) | (MMAP_BLOCK_SIZE - 1)) + 1 | 0;
        dbg_assert((size | 0) > 0);
        dbg_assert((size & MMAP_BLOCK_SIZE - 1) === 0);

        this.memory_size = size;

        var buffer = new ArrayBuffer(size);

        this.mem8 = new Uint8Array(buffer);
        this.mem16 = new Uint16Array(buffer);
        this.mem32s = new Int32Array(buffer);
    }

    public init(settings, device_bus): void
    {
        this.create_memory(typeof settings.memory_size === "number" ?
            settings.memory_size : 1024 * 1024 * 64);

        this.reset();

        var io = new IO(this);
        this.io = io;

        this.bios.main = settings.bios;
        this.bios.vga = settings.vga_bios;

        this.load_bios();

        var a20_byte = 0;

        io.register_read(0xB3, this, function()
        {
            // seabios smm_relocate_and_restore
            dbg_log("port 0xB3 read");
            return 0;
        });

        io.register_read(0x92, this, function()
        {
            return a20_byte;
        });

        io.register_write(0x92, this, function(out_byte)
        {
            a20_byte = out_byte;
        });

        if(DEBUG)
        {
            // Use by linux for port-IO delay
            // Avoid generating tons of debug messages
            io.register_write(0x80, this, function(out_byte)
            {
            });
        }

        this.devices = {};

        // TODO: Make this more configurable
        if(settings.load_devices)
        {
            this.devices.pic = new PIC(this);
            this.devices.pci = new PCI(this);

            if(ENABLE_ACPI)
            {
                this.devices.apic = new APIC(this);
                this.devices.acpi = new ACPI(this);
            }

            this.devices.rtc = new RTC(this);
            this.fill_cmos(this.devices.rtc, settings);

            this.devices.dma = new DMA(this);

            if(ENABLE_HPET)
            {
                this.devices.hpet = new HPET(this);
            }

            this.devices.vga = new VGAScreen(this, device_bus,
                    settings.vga_memory_size || 8 * 1024 * 1024);

            this.fpu = new FPU(this);

            this.devices.ps2 = new PS2(this, device_bus);

            this.devices.uart = new UART(this, 0x3F8, device_bus);

            this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

            var ide_device_count = 0;

            if(settings.hda)
            {
                this.devices.hda = new IDEDevice(this, settings.hda, false, ide_device_count++, device_bus);
            }

            if(settings.cdrom)
            {
                this.devices.cdrom = new IDEDevice(this, settings.cdrom, true, ide_device_count++, device_bus);
            }

            if(settings.hdb)
            {
                this.devices.hdb = new IDEDevice(this, settings.hdb, false, ide_device_count++, device_bus);
            }

            this.devices.pit = new PIT(this);

            if(settings.enable_ne2k)
            {
                this.devices.net = new Ne2k(this, device_bus);
            }

            if(settings.fs9p)
            {
                this.devices.virtio = new VirtIO(this, device_bus, settings.fs9p);
            }
        }

        if(DEBUG)
        {
            this.debug.init();
        }
    }

    public fill_cmos(rtc, settings): void
    {
        var boot_order = settings.boot_order || 0x213;

        // Used by seabios to determine the boot order
        //   Nibble
        //   1: FloppyPrio
        //   2: HDPrio
        //   3: CDPrio
        //   4: BEVPrio
        // bootflag 1, high nibble, lowest priority
        // Low nibble: Disable floppy signature check (1)
        rtc.cmos_write(CMOS_BIOS_BOOTFLAG1 , 1 | boot_order >> 4 & 0xF0);

        // bootflag 2, both nibbles, high and middle priority
        rtc.cmos_write(CMOS_BIOS_BOOTFLAG2, boot_order & 0xFF);

        // 640k or less if less memory is used
        rtc.cmos_write(CMOS_MEM_BASE_LOW, 640 & 0xFF);
        rtc.cmos_write(CMOS_MEM_BASE_HIGH, 640 >> 8);

        var memory_above_1m = 0; // in k
        if(this.memory_size >= 1024 * 1024)
        {
            memory_above_1m = (this.memory_size - 1024 * 1024) >> 10;
            memory_above_1m = Math.min(memory_above_1m, 0xFFFF);
        }

        rtc.cmos_write(CMOS_MEM_OLD_EXT_LOW, memory_above_1m & 0xFF);
        rtc.cmos_write(CMOS_MEM_OLD_EXT_HIGH, memory_above_1m >> 8 & 0xFF);
        rtc.cmos_write(CMOS_MEM_EXTMEM_LOW, memory_above_1m & 0xFF);
        rtc.cmos_write(CMOS_MEM_EXTMEM_HIGH, memory_above_1m >> 8 & 0xFF);

        var memory_above_16m = 0; // in 64k blocks
        if(this.memory_size >= 16 * 1024 * 1024)
        {
            memory_above_16m = (this.memory_size - 16 * 1024 * 1024) >> 16;
            memory_above_16m = Math.min(memory_above_16m, 0xFFFF);
        }
        rtc.cmos_write(CMOS_MEM_EXTMEM2_LOW, memory_above_16m & 0xFF);
        rtc.cmos_write(CMOS_MEM_EXTMEM2_HIGH, memory_above_16m >> 8 & 0xFF);

        // memory above 4G (not supported by this emulator)
        rtc.cmos_write(CMOS_MEM_HIGHMEM_LOW, 0);
        rtc.cmos_write(CMOS_MEM_HIGHMEM_MID, 0);
        rtc.cmos_write(CMOS_MEM_HIGHMEM_HIGH, 0);

        rtc.cmos_write(CMOS_EQUIPMENT_INFO, 0x2F);

        rtc.cmos_write(CMOS_BIOS_SMP_COUNT, 0);
    }

    public load_bios(): void
    {
        var bios = this.bios.main;
        var vga_bios = this.bios.vga;

        if(!bios)
        {
            dbg_log("Warning: No BIOS");
            return;
        }

        // load bios
        var data = new Uint8Array(bios),
            start = 0x100000 - bios.byteLength;

        this.write_blob(data, start);

        if(vga_bios)
        {
            // load vga bios
            data = new Uint8Array(vga_bios);
            this.write_blob(data, 0xC0000);
        }
        else
        {
            dbg_log("Warning: No VGA BIOS");
        }

        // seabios expects the bios to be mapped to 0xFFF00000 also
        this.io.mmap_register(0xFFF00000, 0x100000,
            (addr) =>
            {
                addr &= 0xFFFFF;
                return this.mem8[addr];
            },
            (addr, value) =>
            {
                addr &= 0xFFFFF;
                this.mem8[addr] = value;
            });
    }

    //var __total = 0;
    //var __count = 0;

    public do_run(): void
    {
        var start: number = v86.microtick();
        var now: number = start;

        // outer loop:
        // runs cycles + timers
        for(; now - start < TIME_PER_FRAME;)
        {
            if(ENABLE_HPET)
            {
                this.devices.pit.timer(now, this.devices.hpet.legacy_mode);
                this.devices.rtc.timer(now, this.devices.hpet.legacy_mode);
                this.devices.hpet.timer(now);
            }
            else
            {
                this.devices.pit.timer(now, false);
                this.devices.rtc.timer(now, false);
            }

            if(ENABLE_ACPI)
            {
                //this.devices.apic.timer(now);
                throw "wat";
            }

            this.handle_irqs();
            //var t = performance.now();
            this.do_many_cycles();
            //t = performance.now() - t;
            //__total += t;
            //__count++;

            if(this.in_hlt)
            {
                return;
            }

            now = v86.microtick();
        }
    }

    public do_many_cycles(): void
    {
        try {
            this.do_many_cycles_unsafe();
        }
        catch(e)
        {
            this.exception_cleanup(e);
        }
    }

    public do_many_cycles_unsafe(): void
    {
        // inner loop:
        // runs only cycles
        for(var k = LOOP_COUNTER; k--;)
        {
            this.cycle_internal();
        }
    }

    //var __counts = {};

    /**
     * execute a single instruction cycle on the cpu
     * this includes reading all prefixes and the whole instruction
     */
    public cycle_internal(): void
    {
        this.previous_ip = this.instruction_pointer;
        //console.log(h(this.previous_ip >>> 0));
        //console.assert(this.table === (this.is_32 ? this.table32 : this.table16));
        //console.assert(this.prefixes === 0);

        this.timestamp_counter++;

        // if(PROFILING)
        // {
        //     var start = performance.now();
        // }

        //var addr = this.translate_address_read(this.instruction_pointer);
        //__counts[addr] = __counts[addr] + 1 | 0;
        //this.translate_address_read(this.instruction_pointer + 15|0)
        var opcode = this.read_imm8();

        // if(DEBUG)
        // {
        //     this.debug.logop(this.instruction_pointer - 1 >>> 0, opcode);
        // }

        // call the instruction
        this.table[opcode](this);

        // if(PROFILING)
        // {
        //     var end = performance.now();
        //     instruction_total[opcode] += end - start;
        //     instruction_count[opcode]++;
        // }

        if(this.flags & flag_trap)
        {
            // TODO
            dbg_log("Trap flag: Ignored", LOG_CPU);
        }
    }

    /** @export */
    public cycle(): void
    {
        try
        {
            this.cycle_internal();
        }
        catch(e)
        {
            this.exception_cleanup(e);
        }
    }

    public segment_prefix_op(sreg): void
    {
        dbg_assert(sreg <= 5);
        this.prefixes |= sreg + 1;
        this.run_prefix_instruction();
        this.prefixes = 0;
    }

    public run_prefix_instruction(): void
    {
        if(this.is_osize_32())
        {
            table32[this.read_imm8()](this);
        }
        else
        {
            table16[this.read_imm8()](this);
        }
    }

    public hlt_loop(): any
    {
        //console.log("hlt");
        dbg_assert(!!(this.flags & flag_interrupt));
        //dbg_log("In HLT loop", LOG_CPU);

        var now = v86.microtick();

        if(ENABLE_HPET)
        {
            var pit_time = this.devices.pit.timer(now, this.devices.hpet.legacy_mode);
            var rtc_time = this.devices.rtc.timer(now, this.devices.hpet.legacy_mode);
            this.devices.hpet.timer(now);
        }
        else
        {
            var pit_time = this.devices.pit.timer(now, false);
            var rtc_time = this.devices.rtc.timer(now, false);
        }

        if(ENABLE_ACPI)
        {
            //this.devices.apic.timer(now);
            throw "wat";
        }

        return pit_time < rtc_time ? pit_time : rtc_time;
    }

    public clear_prefixes(): void
    {
        this.prefixes = 0;
    }

    public cr0_changed(old_cr0): void
    {
        //dbg_log("cr0 = " + h(this.cr[0] >>> 0), LOG_CPU);

        var new_paging = (this.cr[0] & CR0_PG) === CR0_PG;

        if(!this.fpu)
        {
            // if there's no FPU, keep emulation set
            this.cr[0] |= CR0_EM;
        }
        this.cr[0] |= CR0_ET;

        this.paging_changed();

        dbg_assert(typeof this.paging === "boolean");
        if(new_paging !== this.paging)
        {
            this.paging = new_paging;
            this.full_clear_tlb();
        }
    }

    public paging_changed(): void
    {
        this.last_virt_eip = -1;
        this.last_virt_esp = -1;
    }

    public cpl_changed(): void
    {
        this.last_virt_eip = -1;
        this.last_virt_esp = -1;
    }

    public read_imm8(): any
    {
        if((this.instruction_pointer & ~0xFFF) ^ this.last_virt_eip)
        {
            this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer;
            this.last_virt_eip = this.instruction_pointer & ~0xFFF;
        }

        var data8 = this.read8(this.eip_phys ^ this.instruction_pointer);
        this.instruction_pointer = this.instruction_pointer + 1 | 0;

        return data8;
    }

    public get_phys_eip(): number
    {
        if((this.instruction_pointer & ~0xFFF) ^ this.last_virt_eip)
        {
            this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer;
            this.last_virt_eip = this.instruction_pointer & ~0xFFF;
        }

        return this.eip_phys ^ this.instruction_pointer;
    }

    public read_imm8s(): number
    {
        return this.read_imm8() << 24 >> 24;
    }

    public read_imm16(): any
    {
        // Two checks in one comparison:
        //    1. Did the high 20 bits of eip change
        // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
        if(((this.instruction_pointer ^ this.last_virt_eip) >>> 0) > 0xFFE)
        {
            return this.read_imm8() | this.read_imm8() << 8;
        }

        var data16 = this.read16(this.eip_phys ^ this.instruction_pointer);
        this.instruction_pointer = this.instruction_pointer + 2 | 0;

        return data16;
    }

    public read_imm32s(): any
    {
        // Analogue to the above comment
        if(((this.instruction_pointer ^ this.last_virt_eip) >>> 0) > 0xFFC)
        {
            return this.read_imm16() | this.read_imm16() << 16;
        }

        var data32 = this.read32s(this.eip_phys ^ this.instruction_pointer);
        this.instruction_pointer = this.instruction_pointer + 4 | 0;

        return data32;
    }

    public read_modrm_byte()
    {
        this.modrm_byte = this.read_imm8();
    }

    public read_op0F = this.read_imm8;
    public read_sib = this.read_imm8;
    public read_op8 = this.read_imm8;
    public read_op8s = this.read_imm8s;
    public read_op16 = this.read_imm16;
    public read_op32s = this.read_imm32s;
    public read_disp8 = this.read_imm8;
    public read_disp8s = this.read_imm8s;
    public read_disp16 = this.read_imm16;
    public read_disp32s = this.read_imm32s;

    public init2 () {};
    public branch_taken () {};
    public branch_not_taken () {};
    public diverged () {};

    public modrm_resolve(modrm_byte): any
    {
        dbg_assert(modrm_byte < 0xC0);

        return (this.is_asize_32() ? this.modrm_table32 : this.modrm_table16)[modrm_byte](this);
    }

    public sib_resolve(mod): any
    {
        return this.sib_table[this.read_sib()](this, mod);
    }

    public clear_instruction_cache() {}

    // read word from a page boundary, given 2 physical addresses
    public virt_boundary_read16(low, high): number
    {
        dbg_assert((low & 0xFFF) === 0xFFF);
        dbg_assert((high & 0xFFF) === 0);

        return this.read8(low) | this.read8(high) << 8;
    }

    // read doubleword from a page boundary, given 2 addresses
    public virt_boundary_read32s(low, high): number
    {
        dbg_assert((low & 0xFFF) >= 0xFFD);
        dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

        var mid;

        if(low & 1)
        {
            if(low & 2)
            {
                // 0xFFF
                mid = this.read_aligned16(high - 2 >> 1);
            }
            else
            {
                // 0xFFD
                mid = this.read_aligned16(low + 1 >> 1);
            }
        }
        else
        {
            // 0xFFE
            mid = this.virt_boundary_read16(low + 1 | 0, high - 1 | 0);
        }

        return this.read8(low) | mid << 8 | this.read8(high) << 24;;
    }

    public virt_boundary_write16(low, high, value): void
    {
        dbg_assert((low & 0xFFF) === 0xFFF);
        dbg_assert((high & 0xFFF) === 0);

        this.write8(low, value);
        this.write8(high, value >> 8);
    }

    public virt_boundary_write32(low, high, value): void
    {
        dbg_assert((low & 0xFFF) >= 0xFFD);
        dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

        this.write8(low, value);
        this.write8(high, value >> 24);

        if(low & 1)
        {
            if(low & 2)
            {
                // 0xFFF
                this.write8(high - 2, value >> 8);
                this.write8(high - 1, value >> 16);
            }
            else
            {
                // 0xFFD
                this.write8(low + 1 | 0, value >> 8);
                this.write8(low + 2 | 0, value >> 16);
            }
        }
        else
        {
            // 0xFFE
            this.write8(low + 1 | 0, value >> 8);
            this.write8(high - 1, value >> 16);
        }
    }

    // safe_read, safe_write
    // read or write byte, word or dword to the given *virtual* address,
    // and be safe on page boundaries

    public safe_read8(addr): number
    {
        dbg_assert(addr < 0x80000000);
        return this.read8(this.translate_address_read(addr));
    }

    public safe_read16(addr): number
    {
        if(this.paging && (addr & 0xFFF) === 0xFFF)
        {
            return this.safe_read8(addr) | this.safe_read8(addr + 1 | 0) << 8;
        }
        else
        {
            return this.read16(this.translate_address_read(addr));
        }
    }

    public safe_read32s(addr): number
    {
        if(this.paging && (addr & 0xFFF) >= 0xFFD)
        {
            return this.safe_read16(addr) | this.safe_read16(addr + 2 | 0) << 16;
        }
        else
        {
            return this.read32s(this.translate_address_read(addr));
        }
    }

    public safe_write8(addr, value): void
    {
        dbg_assert(addr < 0x80000000);
        this.write8(this.translate_address_write(addr), value);
    }

    public safe_write16(addr, value): void
    {
        var phys_low = this.translate_address_write(addr);

        if((addr & 0xFFF) === 0xFFF)
        {
            this.virt_boundary_write16(phys_low, this.translate_address_write(addr + 1 | 0), value);
        }
        else
        {
            this.write16(phys_low, value);
        }
    }

    public safe_write32(addr, value): void
    {
        var phys_low = this.translate_address_write(addr);

        if((addr & 0xFFF) >= 0xFFD)
        {
            this.virt_boundary_write32(phys_low, this.translate_address_write(addr + 3 & ~3) | (addr + 3) & 3, value);
        }
        else
        {
            this.write32(phys_low, value);
        }
    }

    // read 2 or 4 byte from ip, depending on address size attribute
    public read_moffs(): number
    {
        if(this.is_asize_32())
        {
            return this.get_seg_prefix(reg_ds) + this.read_op32s() | 0;
        }
        else
        {
            return this.get_seg_prefix(reg_ds) + this.read_op16() | 0;
        }
    }

    public getiopl(): number
    {
        return this.flags >> 12 & 3;
    }

    public vm86_mode(): boolean
    {
        return !!(this.flags & flag_vm);
    }

    public get_eflags(): number
    {
        return (this.flags & ~flags_all) | this.getcf() | this.getpf() << 2 | this.getaf() << 4 |
                                    this.getzf() << 6 | this.getsf() << 7 | this.getof() << 11;
    };

    public load_eflags(): void
    {
        this.flags = this.get_eflags();
        this.flags_changed = 0;
    };

    /**
     * Update the flags register depending on iopl and cpl
     */
    public update_eflags(new_flags): void
    {
        var dont_update = flag_rf | flag_vm | flag_vip | flag_vif,
            clear = ~flag_vip & ~flag_vif & flags_mask;

        if(this.flags & flag_vm)
        {
            // other case needs to be handled in popf or iret
            dbg_assert(this.getiopl() === 3);

            dont_update |= flag_iopl;

            // don't clear vip or vif
            clear |= flag_vip | flag_vif;
        }
        else
        {
            if(!this.protected_mode) dbg_assert(this.cpl === 0);

            if(this.cpl)
            {
                // cpl > 0
                // cannot update iopl
                dont_update |= flag_iopl;

                if(this.cpl > this.getiopl())
                {
                    // cpl > iopl
                    // cannot update interrupt flag
                    dont_update |= flag_interrupt;
                }
            }
        }

        this.flags = (new_flags ^ ((this.flags ^ new_flags) & dont_update)) & clear | flags_default;

        this.flags_changed = 0;
    }

    public get_stack_reg(): any
    {
        if(this.stack_size_32)
        {
            return this.reg32s[reg_esp];
        }
        else
        {
            return this.reg16[reg_sp];
        }
    }

    public set_stack_reg(value): void
    {
        if(this.stack_size_32)
        {
            this.reg32s[reg_esp] = value;
        }
        else
        {
            this.reg16[reg_sp] = value;
        }
    }

    public adjust_stack_reg(value): void
    {
        if(this.stack_size_32)
        {
            this.reg32s[reg_esp] += value;
        }
        else
        {
            this.reg16[reg_sp] += value;
        }
    }

    public get_stack_pointer(mod): number
    {
        if(this.stack_size_32)
        {
            return this.get_seg(reg_ss) + this.reg32s[reg_esp] + mod | 0;
        }
        else
        {
            return this.get_seg(reg_ss) + (this.reg16[reg_sp] + mod & 0xFFFF) | 0;
        }
    }

    /*
    * returns the "real" instruction pointer,
    * without segment offset
    */
    public get_real_eip(): number
    {
        return this.instruction_pointer - this.get_seg(reg_cs) | 0;
    }

    public call_interrupt_vector(interrupt_nr, is_software_int, error_code): void
    {
        //dbg_log("int " + h(interrupt_nr, 2) + " (" + (is_software_int ? "soft" : "hard") + "ware)", LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("int " + h(interrupt_nr) + " start");
        //this.debug.dump_regs_short();

        this.debug.debug_interrupt(interrupt_nr);

        dbg_assert(error_code === false || typeof error_code === "number");

        // we have to leave hlt_loop at some point, this is a
        // good place to do it
        //this.in_hlt && dbg_log("Leave HLT loop", LOG_CPU);
        this.in_hlt = false;

        if(this.protected_mode)
        {
            if(this.vm86_mode() && (this.cr[4] & CR4_VME))
            {
                throw this.debug.unimpl("VME");
            }

            if(this.vm86_mode() && is_software_int && this.getiopl() < 3)
            {
                dbg_log("call_interrupt_vector #GP. vm86 && software int && iopl < 3", LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_gp(0);
            }

            if((interrupt_nr << 3 | 7) > this.idtr_size)
            {
                dbg_log(interrupt_nr, LOG_CPU);
                dbg_trace(LOG_CPU);
                throw this.debug.unimpl("#GP handler");
            }

            var addr = this.idtr_offset + (interrupt_nr << 3) | 0;
            dbg_assert((addr & 0xFFF) < 0xFF8);

            if(this.paging)
            {
                addr = this.translate_address_system_read(addr);
            }

            var base = this.read16(addr) | this.read16(addr + 6 | 0) << 16;
            var selector = this.read16(addr + 2 | 0);
            var access = this.read8(addr + 5 | 0);
            var dpl = access >> 5 & 3;
            var type = access & 31;

            if((access & 0x80) === 0)
            {
                // present bit not set
                throw this.debug.unimpl("#NP handler");
            }

            if(is_software_int && dpl < this.cpl)
            {
                dbg_log("#gp software interrupt (" + h(interrupt_nr, 2) + ") and dpl < cpl", LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_gp(interrupt_nr << 3 | 2);
            }

            if(type === 5)
            {
                // task gate
                dbg_log("interrupt to task gate: int=" + h(interrupt_nr, 2) + " sel=" + h(selector, 4) + " dpl=" + dpl, LOG_CPU);
                dbg_trace(LOG_CPU);

                this.do_task_switch(selector);

                if(error_code !== false)
                {
                    // TODO: push16 if in 16 bit mode?
                    this.push32(error_code);
                }
                return;
            }

            if((type & ~1 & ~8) !== 6)
            {
                // invalid type
                dbg_trace(LOG_CPU);
                dbg_log("invalid type: " + h(type));
                dbg_log(h(addr) + " " + h(base >>> 0) + " " + h(selector));
                throw this.debug.unimpl("#GP handler");
            }

            var is_trap = (type & 1) === 1;
            var is_16 = (type & 8) === 0;

            var info = this.lookup_segment_selector(selector);

            dbg_assert((base >>> 0) <= info.effective_limit);
            dbg_assert(info.is_valid);

            if(info.is_null)
            {
                dbg_log("is null");
                throw this.debug.unimpl("#GP handler");
            }
            if(!info.is_executable || info.dpl > this.cpl)
            {
                dbg_log("not exec");
                throw this.debug.unimpl("#GP handler");
            }
            if(!info.is_present)
            {
                dbg_log("not present");
                throw this.debug.unimpl("#NP handler");
            }

            this.load_eflags();
            var old_flags = this.flags;

            //dbg_log("interrupt " + h(interrupt_nr, 2) + " (" + (is_software_int ? "soft" : "hard") + "ware) from cpl=" + this.cpl + " vm=" + (this.flags & flag_vm) + " cs:eip=" + h(this.sreg[reg_cs], 4) + ":" + h(this.get_real_eip(), 8) + " to cpl="

            if(!info.dc_bit && info.dpl < this.cpl)
            {
                // inter privilege level interrupt
                // interrupt from vm86 mode

                //dbg_log("Inter privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) + " trap=" + is_trap + " 16bit=" + is_16, LOG_CPU);
                //this.debug.dump_regs_short();
                var tss_stack_addr = this.get_tss_stack_addr(info.dpl);

                var new_esp = this.read32s(tss_stack_addr);
                var new_ss = this.read16(tss_stack_addr + 4 | 0);
                var ss_info = this.lookup_segment_selector(new_ss);

                // Disabled: Incorrect handling of direction bit
                // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
                //if(!((new_esp >>> 0) <= ss_info.effective_limit))
                //    debugger;
                //dbg_assert((new_esp >>> 0) <= ss_info.effective_limit);
                dbg_assert(ss_info.is_valid && !ss_info.is_system && ss_info.is_writable);

                if(ss_info.is_null)
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(ss_info.rpl !== info.dpl) // xxx: 0 in v86 mode
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(ss_info.dpl !== info.dpl || !ss_info.rw_bit)
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(!ss_info.is_present)
                {
                    throw this.debug.unimpl("#TS handler");
                }

                var old_esp = this.reg32s[reg_esp];
                var old_ss = this.sreg[reg_ss];

                if(old_flags & flag_vm)
                {
                    //dbg_log("return from vm86 mode");
                    //this.debug.dump_regs_short();
                    dbg_assert(info.dpl === 0, "switch to non-0 dpl from vm86 mode");
                }

                var stack_space = (is_16 ? 2 : 4) * (5 + (error_code !== false ? 1 : 0) + 4 * ((old_flags & flag_vm) === flag_vm ? 1 : 0));
                var new_stack_pointer = ss_info.base + (ss_info.size ? new_esp - stack_space : (new_esp - stack_space & 0xFFFF));

                // XXX: with new cpl or with cpl 0?
                this.translate_address_system_write(new_stack_pointer);
                this.translate_address_system_write(ss_info.base + new_esp - 1);

                // no exceptions below

                this.cpl = info.dpl;
                this.cpl_changed();

                dbg_assert(typeof info.size === "boolean");
                if(this.is_32 !== info.size)
                {
                    this.update_cs_size(info.size);
                }

                this.flags &= ~flag_vm & ~flag_rf;

                this.switch_seg(reg_ss, new_ss);
                this.set_stack_reg(new_esp);

                if(old_flags & flag_vm)
                {
                    if(is_16)
                    {
                        dbg_assert(false);
                    }
                    else
                    {
                        this.push32(this.sreg[reg_gs]);
                        this.push32(this.sreg[reg_fs]);
                        this.push32(this.sreg[reg_ds]);
                        this.push32(this.sreg[reg_es]);
                    }
                }

                if(is_16)
                {
                    this.push16(old_ss);
                    this.push16(old_esp);
                }
                else
                {
                    this.push32(old_ss);
                    this.push32(old_esp);
                }
            }
            else if(info.dc_bit || info.dpl === this.cpl)
            {
                // intra privilege level interrupt

                //dbg_log("Intra privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) +
                //        " trap=" + is_trap + " 16bit=" + is_16 +
                //        " cpl=" + this.cpl + " dpl=" + info.dpl + " conforming=" + +info.dc_bit, LOG_CPU);
                //this.debug.dump_regs_short();

                if(this.flags & flag_vm)
                {
                    dbg_assert(false, "check error code");
                    this.trigger_gp(selector & ~3);
                }

                var stack_space = (is_16 ? 2 : 4) * (3 + (error_code !== false ? 1 : 0));

                // XXX: with current cpl or with cpl 0?
                this.writable_or_pagefault(this.get_stack_pointer(-stack_space), stack_space);

                // no exceptions below
            }
            else
            {
                throw this.debug.unimpl("#GP handler");
            }

            if(is_16)
            {
                this.push16(old_flags);
                this.push16(this.sreg[reg_cs]);
                this.push16(this.get_real_eip());

                if(error_code !== false)
                {
                    this.push16(error_code);
                }

                base &= 0xFFFF;
            }
            else
            {
                this.push32(old_flags);
                this.push32(this.sreg[reg_cs]);
                this.push32(this.get_real_eip());

                if(error_code !== false)
                {
                    this.push32(error_code);
                }
            }

            if(old_flags & flag_vm)
            {
                this.switch_seg(reg_gs, 0);
                this.switch_seg(reg_fs, 0);
                this.switch_seg(reg_ds, 0);
                this.switch_seg(reg_es, 0);
            }


            this.sreg[reg_cs] = selector & ~3 | this.cpl;
            dbg_assert((this.sreg[reg_cs] & 3) === this.cpl);

            dbg_assert(typeof info.size === "boolean");
            dbg_assert(typeof this.is_32 === "boolean");
            if(this.is_32 !== info.size)
            {
                this.update_cs_size(info.size);
            }

            this.segment_limits[reg_cs] = info.effective_limit;
            this.segment_offsets[reg_cs] = info.base;

            this.instruction_pointer = this.get_seg(reg_cs) + base | 0;

            this.flags &= ~flag_nt & ~flag_vm & ~flag_rf & ~flag_trap;

            if(!is_trap)
            {
                // clear int flag for interrupt gates
                this.flags &= ~flag_interrupt;
            }
            else
            {
                if(!this.page_fault) // XXX
                {
                    this.handle_irqs();
                }
            }
        }
        else
        {
            // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0

            var index = interrupt_nr << 2;
            var new_ip = this.read16(index);
            var new_cs = this.read16(index + 2 | 0);

            // push flags, cs:ip
            this.load_eflags();
            this.push16(this.flags);
            this.push16(this.sreg[reg_cs]);
            this.push16(this.get_real_eip());

            this.flags &= ~flag_interrupt;

            this.switch_cs_real_mode(new_cs);
            this.instruction_pointer = this.get_seg(reg_cs) + new_ip | 0;
        }

        //dbg_log("int to:", LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("int end");
    }

    public iret16(): void
    {
        this.iret(true);
    }

    public iret32(): void
    {
        this.iret(false);
    }

    public iret(is_16): void
    {
        //dbg_log("iret is_16=" + is_16, LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("iret" + (is_16 ? "16" : "32") + " start");
        //this.debug.dump_regs_short();

        if(this.vm86_mode() && this.getiopl() < 3)
        {
            // vm86 mode, iopl != 3
            dbg_log("#gp iret vm86 mode, iopl != 3", LOG_CPU)
            //debugger;
            this.trigger_gp(0);
        }

        if(is_16)
        {
            var new_eip = this.safe_read16(this.get_stack_pointer(0));
            var new_cs = this.safe_read16(this.get_stack_pointer(2));
            var new_flags = this.safe_read16(this.get_stack_pointer(4));
        }
        else
        {
            var new_eip = this.safe_read32s(this.get_stack_pointer(0));
            var new_cs = this.safe_read16(this.get_stack_pointer(4));
            var new_flags = this.safe_read32s(this.get_stack_pointer(8));
        }

        if(!this.protected_mode || (this.vm86_mode() && this.getiopl() === 3))
        {
            if(new_eip & 0xFFFF0000)
            {
                throw this.debug.unimpl("#GP handler");
            }

            this.switch_cs_real_mode(new_cs);
            this.instruction_pointer = new_eip + this.get_seg(reg_cs) | 0;

            if(is_16)
            {
                this.update_eflags(new_flags | this.flags & ~0xFFFF);
                this.adjust_stack_reg(3 * 2);
            }
            else
            {
                this.update_eflags(new_flags);
                this.adjust_stack_reg(3 * 4);
            }

            //dbg_log("iret32 to:", LOG_CPU);
            CPU_LOG_VERBOSE && this.debug.dump_state("iret end");

            this.handle_irqs();
            return;
        }

        dbg_assert(!this.vm86_mode());

        if(this.flags & flag_nt)
        {
            if(DEBUG) throw this.debug.unimpl("nt");
            this.trigger_gp(0);
        }

        if(new_flags & flag_vm)
        {
            if(this.cpl === 0)
            {
                // return to virtual 8086 mode

                // vm86 cannot be set in 16 bit flag
                dbg_assert(!is_16);

                dbg_assert((new_eip & ~0xFFFF) === 0);

                //dbg_log("in vm86 mode now " +
                //        " cs:eip=" + h(new_cs, 4) + ":" + h(this.instruction_pointer >>> 0, 8) +
                //        " iopl=" + this.getiopl() + " flags=" + h(new_flags, 8), LOG_CPU);


                var temp_esp = this.safe_read32s(this.get_stack_pointer(12));
                var temp_ss = this.safe_read16(this.get_stack_pointer(16));

                var new_es = this.safe_read16(this.get_stack_pointer(20));
                var new_ds = this.safe_read16(this.get_stack_pointer(24));
                var new_fs = this.safe_read16(this.get_stack_pointer(28));
                var new_gs = this.safe_read16(this.get_stack_pointer(32));

                // no exceptions below

                this.update_eflags(new_flags);
                this.flags |= flag_vm;

                this.switch_cs_real_mode(new_cs);
                this.instruction_pointer = (new_eip & 0xFFFF) + this.get_seg(reg_cs) | 0;

                this.switch_seg(reg_es, new_es);
                this.switch_seg(reg_ds, new_ds);
                this.switch_seg(reg_fs, new_fs);
                this.switch_seg(reg_gs, new_gs);

                this.adjust_stack_reg(9 * 4); // 9 dwords: eip, cs, flags, esp, ss, es, ds, fs, gs

                this.reg32s[reg_esp] = temp_esp;
                this.switch_seg(reg_ss, temp_ss);

                this.cpl = 3;
                this.cpl_changed();

                this.update_cs_size(false);

                //dbg_log("iret32 to:", LOG_CPU);
                CPU_LOG_VERBOSE && this.debug.dump_state("iret end");
                //this.debug.dump_regs_short();

                return;
            }
            else
            {
                dbg_log("vm86 flag ignored because cpl != 0", LOG_CPU);
                new_flags &= ~flag_vm;
            }
        }

        // protected mode return

        var info = this.lookup_segment_selector(new_cs);

        dbg_assert(info.is_valid);
        dbg_assert((new_eip >>> 0) <= info.effective_limit);

        if(info.is_null)
        {
            throw this.debug.unimpl("is null");
        }
        if(!info.is_present)
        {
            throw this.debug.unimpl("not present");
        }
        if(!info.is_executable)
        {
            throw this.debug.unimpl("not exec");
        }
        if(info.rpl < this.cpl)
        {
            throw this.debug.unimpl("rpl < cpl");
        }
        if(info.dc_bit && info.dpl > info.rpl)
        {
            throw this.debug.unimpl("conforming and dpl > rpl");
        }

        if(!info.dc_bit && info.rpl !== info.dpl)
        {
            dbg_log("#gp iret: non-conforming cs and rpl != dpl, dpl=" + info.dpl + " rpl=" + info.rpl, LOG_CPU);
            this.trigger_gp(0);
        }

        if(info.rpl > this.cpl)
        {
            // outer privilege return
            if(is_16)
            {
                var temp_esp = this.safe_read16(this.get_stack_pointer(6));
                var temp_ss = this.safe_read16(this.get_stack_pointer(8));
            }
            else
            {
                var temp_esp = this.safe_read32s(this.get_stack_pointer(12));
                var temp_ss = this.safe_read16(this.get_stack_pointer(16));
            }

            var ss_info = this.lookup_segment_selector(temp_ss);
            var new_cpl = info.rpl;

            if(ss_info.is_null)
            {
                dbg_log("#GP for loading 0 in SS sel=" + h(temp_ss, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_gp(0);
            }

            if(!ss_info.is_valid ||
            ss_info.is_system ||
            ss_info.rpl !== new_cpl ||
            !ss_info.is_writable ||
            ss_info.dpl !== new_cpl)
            {
                dbg_log("#GP for loading invalid in SS sel=" + h(temp_ss, 4), LOG_CPU);
                //debugger;
                dbg_trace(LOG_CPU);
                this.trigger_gp(temp_ss & ~3);
            }

            if(!ss_info.is_present)
            {
                dbg_log("#SS for loading non-present in SS sel=" + h(temp_ss, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_ss(temp_ss & ~3);
            }

            // no exceptions below

            if(is_16)
            {
                this.update_eflags(new_flags | this.flags & ~0xFFFF);
            }
            else
            {
                this.update_eflags(new_flags);
            }

            this.cpl = info.rpl;
            this.cpl_changed();

            //dbg_log("outer privilege return: from=" + this.cpl + " to=" + info.rpl + " ss:esp=" + h(temp_ss, 4) + ":" + h(temp_esp >>> 0, 8), LOG_CPU);

            this.switch_seg(reg_ss, temp_ss);

            this.set_stack_reg(temp_esp);

            if(this.cpl === 0)
            {
                this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
            }


            // XXX: Set segment to 0 if it's not usable in the new cpl
            // XXX: Use cached segment information
            //var ds_info = this.lookup_segment_selector(this.sreg[reg_ds]);
            //if(this.cpl > ds_info.dpl && (!ds_info.is_executable || !ds_info.dc_bit)) this.switch_seg(reg_ds, 0);
            // ...
        }
        else if(info.rpl === this.cpl)
        {
            // same privilege return
            // no exceptions below
            if(is_16)
            {
                this.adjust_stack_reg(3 * 2);
                this.update_eflags(new_flags | this.flags & ~0xFFFF);
            }
            else
            {
                this.adjust_stack_reg(3 * 4);
                this.update_eflags(new_flags);
            }

            // update vip and vif, which are not changed by update_eflags
            if(this.cpl === 0)
            {
                this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
            }
        }
        else
        {
            dbg_assert(false);
        }

        this.sreg[reg_cs] = new_cs;
        dbg_assert((new_cs & 3) === this.cpl);

        dbg_assert(typeof info.size === "boolean");
        if(info.size !== this.is_32)
        {
            this.update_cs_size(info.size);
        }

        this.segment_limits[reg_cs] = info.effective_limit;
        this.segment_offsets[reg_cs] = info.base;

        this.instruction_pointer = new_eip + this.get_seg(reg_cs) | 0;

        CPU_LOG_VERBOSE && this.debug.dump_state("iret" + (is_16 ? "16" : "32") + " end");

        this.handle_irqs();
    }

    public switch_cs_real_mode(selector): void
    {
        dbg_assert(!this.protected_mode || this.vm86_mode());

        this.sreg[reg_cs] = selector;
        this.segment_is_null[reg_cs] = 0;
        this.segment_offsets[reg_cs] = selector << 4;
    }

    public far_return(eip, selector, stack_adjust): void
    {
        dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

        //dbg_log("far return eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4) + " stack_adjust=" + h(stack_adjust), LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("far ret start");

        this.protected_mode = (this.cr[0] & CR0_PE) === CR0_PE;

        if(!this.protected_mode)
        {
            dbg_assert(!this.is_32);
            //dbg_assert(!this.stack_size_32);
        }

        if(!this.protected_mode || this.vm86_mode())
        {
            this.switch_cs_real_mode(selector);
            this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
            this.adjust_stack_reg(2 * (this.is_osize_32() ? 4 : 2) + stack_adjust);
            return;
        }

        var info = this.lookup_segment_selector(selector);

        if(info.is_null)
        {
            dbg_log("null cs", LOG_CPU);
            this.trigger_gp(0);
        }

        if(!info.is_valid)
        {
            dbg_log("invalid cs: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(info.is_system)
        {
            dbg_assert(false, "is system in far return");
            this.trigger_gp(selector & ~3);
        }

        if(!info.is_executable)
        {
            dbg_log("non-executable cs: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(info.rpl < this.cpl)
        {
            dbg_log("cs rpl < cpl: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(info.dc_bit && info.dpl > info.rpl)
        {
            dbg_log("cs conforming and dpl > rpl: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(!info.dc_bit && info.dpl !== info.rpl)
        {
            dbg_log("cs non-conforming and dpl != rpl: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(!info.is_present)
        {
            dbg_log("#NP for loading not-present in cs sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_np(selector & ~3);
        }

        if(info.rpl > this.cpl)
        {
            dbg_log("far return privilege change cs: " + h(selector) + " from=" + this.cpl + " to=" + info.rpl + " is_16=" + this.is_osize_32(), LOG_CPU);

            if(this.is_osize_32())
            {
                //dbg_log("esp read from " + h(this.translate_address_system_read(this.get_stack_pointer(stack_adjust + 8))))
                var temp_esp = this.safe_read32s(this.get_stack_pointer(stack_adjust + 8));
                //dbg_log("esp=" + h(temp_esp));
                var temp_ss = this.safe_read16(this.get_stack_pointer(stack_adjust + 12));
            }
            else
            {
                //dbg_log("esp read from " + h(this.translate_address_system_read(this.get_stack_pointer(stack_adjust + 4))));
                var temp_esp = this.safe_read16(this.get_stack_pointer(stack_adjust + 4));
                //dbg_log("esp=" + h(temp_esp));
                var temp_ss = this.safe_read16(this.get_stack_pointer(stack_adjust + 6));
            }

            this.cpl = info.rpl;
            this.cpl_changed();

            // XXX: Can raise, conditions should be checked before side effects
            try {
            this.switch_seg(reg_ss, temp_ss);
            } catch(e) { console.log(e); console.assert(false); }
            this.set_stack_reg(temp_esp + stack_adjust);

            //if(this.is_osize_32())
            //{
            //    this.adjust_stack_reg(2 * 4);
            //}
            //else
            //{
            //    this.adjust_stack_reg(2 * 2);
            //}

            //throw this.debug.unimpl("privilege change");

            //this.adjust_stack_reg(stack_adjust);
        }
        else
        {
            if(this.is_osize_32())
            {
                this.adjust_stack_reg(2 * 4 + stack_adjust);
            }
            else
            {
                this.adjust_stack_reg(2 * 2 + stack_adjust);
            }
        }

        //dbg_assert(this.cpl === info.dpl);

        dbg_assert(typeof info.size === "boolean");
        if(info.size !== this.is_32)
        {
            this.update_cs_size(info.size);
        }

        this.segment_is_null[reg_cs] = 0;
        this.segment_limits[reg_cs] = info.effective_limit;
        //this.segment_infos[reg_cs] = 0; // TODO

        this.segment_offsets[reg_cs] = info.base;
        this.sreg[reg_cs] = selector;
        dbg_assert((selector & 3) === this.cpl);

        this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;

        //dbg_log("far return to:", LOG_CPU)
        CPU_LOG_VERBOSE && this.debug.dump_state("far ret end");
    }

    public far_jump(eip, selector, is_call): void
    {
        dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

        //dbg_log("far " + ["jump", "call"][+is_call] + " eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4), LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("far " + ["jump", "call"][+is_call]);

        this.protected_mode = (this.cr[0] & CR0_PE) === CR0_PE;

        if(!this.protected_mode || this.vm86_mode())
        {
            if(is_call)
            {
                if(this.is_osize_32())
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                    this.push32(this.sreg[reg_cs]);
                    this.push32(this.get_real_eip());
                }
                else
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                    this.push16(this.sreg[reg_cs]);
                    this.push16(this.get_real_eip());
                }
            }
            this.switch_cs_real_mode(selector);
            this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
            return;
        }

        var info = this.lookup_segment_selector(selector);

        if(info.is_null)
        {
            dbg_log("#gp null cs", LOG_CPU);
            this.trigger_gp(0);
        }

        if(!info.is_valid)
        {
            dbg_log("#gp invalid cs: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(info.is_system)
        {
            dbg_assert(is_call, "TODO: Jump")

            dbg_log("system type cs: " + h(selector), LOG_CPU);

            if(info.type === 0xC || info.type === 4)
            {
                // call gate
                var is_16 = info.type === 4;

                if(info.dpl < this.cpl || info.dpl < info.rpl)
                {
                    dbg_log("#gp cs gate dpl < cpl or dpl < rpl: " + h(selector), LOG_CPU);
                    this.trigger_gp(selector & ~3);
                }

                if(!info.is_present)
                {
                    dbg_log("#NP for loading not-present in gate cs sel=" + h(selector, 4), LOG_CPU);
                    this.trigger_np(selector & ~3);
                }

                var cs_selector = info.raw0 >>> 16;
                var cs_info = this.lookup_segment_selector(cs_selector);

                if(cs_info.is_null)
                {
                    dbg_log("#gp null cs", LOG_CPU);
                    this.trigger_gp(0);
                }

                if(!cs_info.is_valid)
                {
                    dbg_log("#gp invalid cs: " + h(cs_selector), LOG_CPU);
                    this.trigger_gp(cs_selector & ~3);
                }

                if(!cs_info.is_executable)
                {
                    dbg_log("#gp non-executable cs: " + h(cs_selector), LOG_CPU);
                    this.trigger_gp(cs_selector & ~3);
                }

                if(cs_info.dpl > this.cpl)
                {
                    dbg_log("#gp dpl > cpl: " + h(cs_selector), LOG_CPU);
                    this.trigger_gp(cs_selector & ~3);
                }

                if(!cs_info.is_present)
                {
                    dbg_log("#NP for loading not-present in cs sel=" + h(cs_selector, 4), LOG_CPU);
                    this.trigger_np(cs_selector & ~3);
                }

                if(!cs_info.dc_bit && cs_info.dpl < this.cpl)
                {
                    dbg_log("more privilege call gate is_16=" + is_16 + " from=" + this.cpl + " to=" + cs_info.dpl);
                    var tss_stack_addr = this.get_tss_stack_addr(cs_info.dpl);

                    var new_esp = this.read32s(tss_stack_addr);
                    var new_ss = this.read16(tss_stack_addr + 4 | 0);
                    var ss_info = this.lookup_segment_selector(new_ss);

                    // Disabled: Incorrect handling of direction bit
                    // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
                    //if(!((new_esp >>> 0) <= ss_info.effective_limit))
                    //    debugger;
                    //dbg_assert((new_esp >>> 0) <= ss_info.effective_limit);
                    dbg_assert(ss_info.is_valid && !ss_info.is_system && ss_info.is_writable);

                    if(ss_info.is_null)
                    {
                        throw this.debug.unimpl("#TS handler");
                    }
                    if(ss_info.rpl !== cs_info.dpl) // xxx: 0 in v86 mode
                    {
                        throw this.debug.unimpl("#TS handler");
                    }
                    if(ss_info.dpl !== cs_info.dpl || !ss_info.rw_bit)
                    {
                        throw this.debug.unimpl("#TS handler");
                    }
                    if(!ss_info.is_present)
                    {
                        throw this.debug.unimpl("#SS handler");
                    }

                    var parameter_count = info.raw1 & 0x1F;
                    var stack_space = is_16 ? 4 : 8;
                    if(is_call)
                    {
                        stack_space += is_16 ? 4 + 2 * parameter_count : 8 + 4 * parameter_count;
                    }
                    if(ss_info.size)
                    {
                        //try {
                        this.writable_or_pagefault(ss_info.base + new_esp - stack_space | 0, stack_space); // , cs_info.dpl
                        //} catch(e) { debugger; }
                    }
                    else
                    {
                        //try {
                        this.writable_or_pagefault(ss_info.base + (new_esp - stack_space & 0xFFFF) | 0, stack_space); // , cs_info.dpl
                        //} catch(e) { debugger; }
                    }

                    var old_esp = this.reg32s[reg_esp];
                    var old_ss = this.sreg[reg_ss];
                    var old_stack_pointer = this.get_stack_pointer(0);

                    //dbg_log("old_esp=" + h(old_esp));

                    this.cpl = cs_info.dpl;
                    this.cpl_changed();

                    if(this.is_32 !== cs_info.size)
                    {
                        this.update_cs_size(cs_info.size);
                    }

                    this.switch_seg(reg_ss, new_ss);
                    this.set_stack_reg(new_esp);

                    //dbg_log("parameter_count=" + parameter_count);
                    //dbg_assert(parameter_count === 0, "TODO");

                    if(is_16)
                    {
                        this.push16(old_ss);
                        this.push16(old_esp);
                        //dbg_log("old esp written to " + h(this.translate_address_system_read(this.get_stack_pointer(0))));
                    }
                    else
                    {
                        this.push32(old_ss);
                        this.push32(old_esp);
                        //dbg_log("old esp written to " + h(this.translate_address_system_read(this.get_stack_pointer(0))));
                    }

                    if(is_call)
                    {
                        if(is_16)
                        {
                            for(var i = parameter_count - 1; i >= 0; i--)
                            {
                                var parameter = this.safe_read16(old_stack_pointer + 2 * i);
                                this.push16(parameter);
                            }

                            //this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                            this.push16(this.sreg[reg_cs]);
                            this.push16(this.get_real_eip());
                        }
                        else
                        {
                            for(var i = parameter_count - 1; i >= 0; i--)
                            {
                                var parameter = this.safe_read32s(old_stack_pointer + 4 * i);
                                this.push32(parameter);
                            }

                            //this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                            this.push32(this.sreg[reg_cs]);
                            this.push32(this.get_real_eip());
                        }
                    }
                }
                else
                {
                    dbg_log("same privilege call gate is_16=" + is_16 + " from=" + this.cpl + " to=" + cs_info.dpl + " conforming=" + cs_info.dc_bit);
                    // ok

                    if(is_call)
                    {
                        if(is_16)
                        {
                            this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                            this.push16(this.sreg[reg_cs]);
                            this.push16(this.get_real_eip());
                        }
                        else
                        {
                            this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                            this.push32(this.sreg[reg_cs]);
                            this.push32(this.get_real_eip());
                        }
                    }
                }

                // Note: eip from call is ignored
                var new_eip = info.raw0 & 0xFFFF;
                if(!is_16)
                {
                    new_eip |= info.raw1 & 0xFFFF0000;
                }

                dbg_log("call gate eip=" + h(new_eip >>> 0) + " cs=" + h(cs_selector) + " conforming=" + cs_info.dc_bit);
                dbg_assert((new_eip >>> 0) <= cs_info.effective_limit, "todo: #gp");

                if(cs_info.size !== this.is_32)
                {
                    this.update_cs_size(cs_info.size);
                }

                this.segment_is_null[reg_cs] = 0;
                this.segment_limits[reg_cs] = cs_info.effective_limit;
                //this.segment_infos[reg_cs] = 0; // TODO
                this.segment_offsets[reg_cs] = cs_info.base;
                this.sreg[reg_cs] = cs_selector & ~3 | this.cpl;
                dbg_assert((this.sreg[reg_cs] & 3) === this.cpl);

                this.instruction_pointer = this.get_seg(reg_cs) + new_eip | 0;
            }
            else
            {
                var types = { 9: "Available 386 TSS", 0xb: "Busy 386 TSS", 4: "286 Call Gate", 0xc: "386 Call Gate" };
                throw this.debug.unimpl("load system segment descriptor, type = " + (info.access & 15) + " (" + types[info.access & 15] + ")");
            }
        }
        else
        {
            if(!info.is_executable)
            {
                dbg_log("#gp non-executable cs: " + h(selector), LOG_CPU);
                this.trigger_gp(selector & ~3);
            }

            if(info.dc_bit)
            {
                // conforming code segment
                if(info.dpl > this.cpl)
                {
                    dbg_log("#gp cs dpl > cpl: " + h(selector), LOG_CPU);
                    this.trigger_gp(selector & ~3);
                }
            }
            else
            {
                // non-conforming code segment

                if(info.rpl > this.cpl || info.dpl !== this.cpl)
                {
                    dbg_log("#gp cs rpl > cpl or dpl != cpl: " + h(selector), LOG_CPU);
                    this.trigger_gp(selector & ~3);
                }
            }

            if(!info.is_present)
            {
                dbg_log("#NP for loading not-present in cs sel=" + h(selector, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_np(selector & ~3);
            }

            if(is_call)
            {
                if(this.is_osize_32())
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                    this.push32(this.sreg[reg_cs]);
                    this.push32(this.get_real_eip());
                }
                else
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                    this.push16(this.sreg[reg_cs]);
                    this.push16(this.get_real_eip());
                }
            }

            dbg_assert((eip >>> 0) <= info.effective_limit, "todo: #gp");

            if(info.size !== this.is_32)
            {
                this.update_cs_size(info.size);
            }

            this.segment_is_null[reg_cs] = 0;
            this.segment_limits[reg_cs] = info.effective_limit;
            //this.segment_infos[reg_cs] = 0; // TODO

            this.segment_offsets[reg_cs] = info.base;
            this.sreg[reg_cs] = selector & ~3 | this.cpl;

            this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
        }

        //dbg_log("far " + ["jump", "call"][+is_call] + " to:", LOG_CPU)
        CPU_LOG_VERBOSE && this.debug.dump_state("far " + ["jump", "call"][+is_call] + " end");
    }

    public get_tss_stack_addr(dpl): number
    {
        var tss_stack_addr = (dpl << 3) + 4 | 0;

        if((tss_stack_addr + 5 | 0) > this.segment_limits[reg_tr])
        {
            throw this.debug.unimpl("#TS handler");
        }

        tss_stack_addr = tss_stack_addr + this.segment_offsets[reg_tr] | 0;

        if(this.paging)
        {
            tss_stack_addr = this.translate_address_system_read(tss_stack_addr);
        }

        dbg_assert((tss_stack_addr & 0xFFF) <= 0x1000 - 6);

        return tss_stack_addr;
    }

    public do_task_switch(selector): void
    {
        dbg_log("do_task_switch sel=" + h(selector), LOG_CPU);
        var descriptor = this.lookup_segment_selector(selector);

        if(!descriptor.is_valid || descriptor.is_null || !descriptor.from_gdt)
        {
            throw this.debug.unimpl("#GP handler");
        }

        if((descriptor.access & 31) === 0xB)
        {
            // is busy
            throw this.debug.unimpl("#GP handler");
        }

        if(!descriptor.is_present)
        {
            throw this.debug.unimpl("#NP handler");
        }

        if(descriptor.effective_limit < 103)
        {
            throw this.debug.unimpl("#NP handler");
        }

        var tsr_size = this.segment_limits[reg_tr];
        var tsr_offset = this.segment_offsets[reg_tr];

        var old_eflags = this.get_eflags();

        //if(false /* is iret */)
        //{
        //    old_eflags &= ~flag_nt;
        //}

        this.writable_or_pagefault(tsr_offset, 0x66);

        //this.safe_write32(tsr_offset + TSR_CR3, this.cr[3]);

        this.safe_write32(tsr_offset + TSR_EIP, this.get_real_eip());
        this.safe_write32(tsr_offset + TSR_EFLAGS, old_eflags);

        this.safe_write32(tsr_offset + TSR_EAX, this.reg32s[reg_eax]);
        this.safe_write32(tsr_offset + TSR_ECX, this.reg32s[reg_ecx]);
        this.safe_write32(tsr_offset + TSR_EDX, this.reg32s[reg_edx]);
        this.safe_write32(tsr_offset + TSR_EBX, this.reg32s[reg_ebx]);

        this.safe_write32(tsr_offset + TSR_ESP, this.reg32s[reg_esp]);
        this.safe_write32(tsr_offset + TSR_EBP, this.reg32s[reg_ebp]);
        this.safe_write32(tsr_offset + TSR_ESI, this.reg32s[reg_esi]);
        this.safe_write32(tsr_offset + TSR_EDI, this.reg32s[reg_edi]);

        this.safe_write32(tsr_offset + TSR_ES, this.sreg[reg_es]);
        this.safe_write32(tsr_offset + TSR_CS, this.sreg[reg_cs]);
        this.safe_write32(tsr_offset + TSR_SS, this.sreg[reg_ss]);
        this.safe_write32(tsr_offset + TSR_DS, this.sreg[reg_ds]);
        this.safe_write32(tsr_offset + TSR_FS, this.sreg[reg_fs]);
        this.safe_write32(tsr_offset + TSR_GS, this.sreg[reg_gs]);
        this.safe_write32(tsr_offset + TSR_LDT, this.sreg[reg_ldtr]);

        if(true /* is jump or call or int */)
        {
            // mark as busy
            this.write8(descriptor.table_offset + 5 | 0, this.read8(descriptor.table_offset + 5 | 0) | 2);
        }

        //var new_tsr_size = descriptor.effective_limit;
        var new_tsr_offset = descriptor.base;

        var new_cr3 = this.safe_read32s(new_tsr_offset + TSR_CR3);

        this.flags &= ~flag_vm;

        dbg_assert(false);
        this.switch_seg(reg_cs, this.safe_read16(new_tsr_offset + TSR_CS));

        var new_eflags = this.safe_read32s(new_tsr_offset + TSR_EFLAGS);

        if(true /* is call or int */)
        {
            this.safe_write32(tsr_offset + TSR_BACKLINK, selector);
            new_eflags |= flag_nt;
        }

        if(new_eflags & flag_vm)
        {
            throw this.debug.unimpl("task switch to VM mode");
        }

        this.update_eflags(new_eflags);

        var new_ldt = this.safe_read16(new_tsr_offset + TSR_LDT);
        this.load_ldt(new_ldt);

        this.reg32s[reg_eax] = this.safe_read32s(new_tsr_offset + TSR_EAX);
        this.reg32s[reg_ecx] = this.safe_read32s(new_tsr_offset + TSR_ECX);
        this.reg32s[reg_edx] = this.safe_read32s(new_tsr_offset + TSR_EDX);
        this.reg32s[reg_ebx] = this.safe_read32s(new_tsr_offset + TSR_EBX);

        this.reg32s[reg_esp] = this.safe_read32s(new_tsr_offset + TSR_ESP);
        this.reg32s[reg_ebp] = this.safe_read32s(new_tsr_offset + TSR_EBP);
        this.reg32s[reg_esi] = this.safe_read32s(new_tsr_offset + TSR_ESI);
        this.reg32s[reg_edi] = this.safe_read32s(new_tsr_offset + TSR_EDI);

        this.switch_seg(reg_es, this.safe_read16(new_tsr_offset + TSR_ES));
        this.switch_seg(reg_ss, this.safe_read16(new_tsr_offset + TSR_SS));
        this.switch_seg(reg_ds, this.safe_read16(new_tsr_offset + TSR_DS));
        this.switch_seg(reg_fs, this.safe_read16(new_tsr_offset + TSR_FS));
        this.switch_seg(reg_gs, this.safe_read16(new_tsr_offset + TSR_GS));

        this.instruction_pointer = this.get_seg(reg_cs) + this.safe_read32s(new_tsr_offset + TSR_EIP) | 0;

        this.segment_offsets[reg_tr] = descriptor.base;
        this.segment_limits[reg_tr] = descriptor.effective_limit;
        this.sreg[reg_tr] = selector;

        this.cr[3] = new_cr3;
        dbg_assert((this.cr[3] & 0xFFF) === 0);
        this.clear_tlb();

        this.cr[0] |= CR0_TS;
    }

    public hlt_op(): void
    {
        //console.log("hlt op");
        if(this.cpl)
        {
            this.trigger_gp(0);
        }

        if((this.flags & flag_interrupt) === 0)
        {
            this.debug.show("cpu halted");
            if(DEBUG) this.debug.dump_regs();
            throw "HALT";
        }
        else
        {
            // get out of here and into hlt_loop
            this.in_hlt = true;

            // if(false) // possibly unsafe, test in safari
            // {
            //     this.hlt_loop();
            //     this.diverged();

            //     if(this.in_hlt)
            //     {
            //         throw MAGIC_CPU_EXCEPTION;
            //     }
            // }
            // else
            {
                throw MAGIC_CPU_EXCEPTION;
            }
        }
    }

    // assumes ip to point to the byte before the next instruction
    public raise_exception(interrupt_nr): void
    {
        //if(DEBUG && interrupt_nr !== 7)
        //{
        //    // show interesting exceptions
        //    dbg_log("Exception " + h(interrupt_nr) + " at " + h(this.previous_ip >>> 0, 8) + " (cs=" + h(this.sreg[reg_cs], 4) + ")", LOG_CPU);
        //    dbg_trace(LOG_CPU);
        //    this.debug.dump_regs_short();
        //    this.debug.dump_state();
        //}

        this.call_interrupt_vector(interrupt_nr, false, false);
        throw MAGIC_CPU_EXCEPTION;
    }

    public raise_exception_with_code(interrupt_nr, error_code): void
    {
        dbg_assert(typeof error_code === "number");

        //if(DEBUG)
        //{
        //    dbg_log("Exception " + h(interrupt_nr) + " err=" + h(error_code) + " at " + h(this.previous_ip >>> 0, 8) + " (cs=" + h(this.sreg[reg_cs], 4) + ")", LOG_CPU);
        //    dbg_trace(LOG_CPU);
        //    this.debug.dump_regs_short();
        //}

        this.call_interrupt_vector(interrupt_nr, false, error_code);
        throw MAGIC_CPU_EXCEPTION;
    }

    public trigger_de(): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception(0);
    }

    public trigger_ud(): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception(6);
    }

    public trigger_nm(): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception(7);
    }

    public trigger_ts(code): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception_with_code(10, code);
    }

    public trigger_gp(code): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception_with_code(13, code);
    }

    public trigger_np(code): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception_with_code(11, code);
    }

    public trigger_ss(code): void
    {
        this.instruction_pointer = this.previous_ip;
        this.raise_exception_with_code(12, code);
    }

    // used before fpu instructions
    public task_switch_test(): void
    {
        if(this.cr[0] & (CR0_EM | CR0_TS))
        {
            this.trigger_nm();
        }
    }

    public todo(): void
    {
        if(DEBUG)
        {
            dbg_trace();
            throw "TODO";
        }

        this.trigger_ud();
    }

    public undefined_instruction(): void
    {
        if(DEBUG)
        {
            throw "Possible fault: undefined instruction";
        }

        this.trigger_ud();
    }

    public unimplemented_sse(): void
    {
        dbg_log("No SSE", LOG_CPU);
        this.trigger_ud();
    }

    public get_seg_prefix_ds(): any
    {
        return this.get_seg_prefix(reg_ds);
    }

    public get_seg_prefix_ss(): any
    {
        return this.get_seg_prefix(reg_ss);
    }

    public get_seg_prefix_cs(): any
    {
        return this.get_seg_prefix(reg_cs);
    }

    /**
     * Get segment base by prefix or default
     */
    public get_seg_prefix(default_segment: number /*, offset*/): any
    {
        var prefix = this.prefixes & PREFIX_MASK_SEGMENT;

        if(prefix)
        {
            if(prefix === SEG_PREFIX_ZERO)
            {
                return 0;
            }
            else
            {
                return this.get_seg(prefix - 1 /*, offset*/);
            }
        }
        else
        {
            return this.get_seg(default_segment /*, offset*/);
        }
    }

    /**
     * Get segment base
     */
    public get_seg(segment: number /*, offset*/): any
    {
        dbg_assert(segment >= 0 && segment < 8);

        if(this.protected_mode)
        {
            if(this.segment_is_null[segment])
            {
                dbg_assert(segment !== reg_cs && segment !== reg_ss);
                dbg_log("#gp Use null segment: " + segment + " sel=" + h(this.sreg[segment], 4), LOG_CPU);

                this.trigger_gp(0);
            }

            // TODO:
            // - validate segment limits
            // - validate if segment is writable
        }

        return this.segment_offsets[segment];
    }

    public read_e8(): any
    {
        if(this.modrm_byte < 0xC0) {
            return this.safe_read8(this.modrm_resolve(this.modrm_byte));
        } else {
            return this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1];
        }
    }

    public read_e8s(): number
    {
        return this.read_e8() << 24 >> 24;
    }

    public read_e16(): any
    {
        if(this.modrm_byte < 0xC0) {
            return this.safe_read16(this.modrm_resolve(this.modrm_byte));
        } else {
            return this.reg16[this.modrm_byte << 1 & 14];
        }
    }

    public read_e16s(): number
    {
        return this.read_e16() << 16 >> 16;
    }

    public read_e32s(): any
    {
        if(this.modrm_byte < 0xC0) {
            return this.safe_read32s(this.modrm_resolve(this.modrm_byte));
        } else {
            return this.reg32s[this.modrm_byte & 7];
        }
    }

    public read_e32(): number
    {
        return this.read_e32s() >>> 0;
    }

    public set_e8(value): void
    {
        if(this.modrm_byte < 0xC0) {
            var addr = this.modrm_resolve(this.modrm_byte);
            this.safe_write8(addr, value);
        } else {
            this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1] = value;
        }
    }

    public set_e16(value): void
    {
        if(this.modrm_byte < 0xC0) {
            var addr = this.modrm_resolve(this.modrm_byte);
            this.safe_write16(addr, value);
        } else {
            this.reg16[this.modrm_byte << 1 & 14] = value;
        }
    }

    public set_e32(value): void
    {
        if(this.modrm_byte < 0xC0) {
            var addr = this.modrm_resolve(this.modrm_byte);
            this.safe_write32(addr, value);
        } else {
            this.reg32s[this.modrm_byte & 7] = value;
        }
    }


    public read_write_e8(): any
    {
        if(this.modrm_byte < 0xC0) {
            var virt_addr = this.modrm_resolve(this.modrm_byte);
            this.phys_addr = this.translate_address_write(virt_addr);
            return this.read8(this.phys_addr);
        } else {
            return this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1];
        }
    }

    public write_e8(value): void
    {
        if(this.modrm_byte < 0xC0) {
            this.write8(this.phys_addr, value);
        }
        else {
            this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1] = value;
        }
    }

    public read_write_e16(): any
    {
        if(this.modrm_byte < 0xC0) {
            var virt_addr = this.modrm_resolve(this.modrm_byte);
            this.phys_addr = this.translate_address_write(virt_addr);
            if(this.paging && (virt_addr & 0xFFF) === 0xFFF) {
                this.phys_addr_high = this.translate_address_write(virt_addr + 1 | 0);
                dbg_assert(!!this.phys_addr_high);
                return this.virt_boundary_read16(this.phys_addr, this.phys_addr_high);
            } else {
                this.phys_addr_high = 0;
                return this.read16(this.phys_addr);
            }
        } else {
            return this.reg16[this.modrm_byte << 1 & 14];
        }
    }

    public write_e16(value): void
    {
        if(this.modrm_byte < 0xC0) {
            if(this.phys_addr_high) {
                this.virt_boundary_write16(this.phys_addr, this.phys_addr_high, value);
            } else {
                this.write16(this.phys_addr, value);
            }
        } else {
            this.reg16[this.modrm_byte << 1 & 14] = value;
        }
    }

    public read_write_e32(): any
    {
        if(this.modrm_byte < 0xC0) {
            var virt_addr = this.modrm_resolve(this.modrm_byte);
            this.phys_addr = this.translate_address_write(virt_addr);
            if(this.paging && (virt_addr & 0xFFF) >= 0xFFD) {
                //this.phys_addr_high = this.translate_address_write(virt_addr + 3 | 0);
                this.phys_addr_high = this.translate_address_write(virt_addr + 3 & ~3) | (virt_addr + 3) & 3;
                dbg_assert(!!this.phys_addr_high);
                return this.virt_boundary_read32s(this.phys_addr, this.phys_addr_high);
            } else {
                this.phys_addr_high = 0;
                return this.read32s(this.phys_addr);
            }
        } else {
            return this.reg32s[this.modrm_byte & 7];
        }
    }

    public write_e32(value): void
    {
        if(this.modrm_byte < 0xC0) {
            if(this.phys_addr_high) {
                this.virt_boundary_write32(this.phys_addr, this.phys_addr_high, value);
            } else {
                this.write32(this.phys_addr, value);
            }
        } else {
            this.reg32s[this.modrm_byte & 7] = value;
        }
    }

    public read_reg_e16()
    {
        return this.reg16[this.modrm_byte << 1 & 14];
    }

    public write_reg_e16(value): void
    {
        this.reg16[this.modrm_byte << 1 & 14] = value;
    }

    public read_reg_e32s(): any
    {
        return this.reg32s[this.modrm_byte & 7];
    }

    public write_reg_e32(value): void
    {
        this.reg32s[this.modrm_byte & 7] = value;
    }

    public read_g8(): any
    {
        return this.reg8[this.modrm_byte >> 1 & 0xC | this.modrm_byte >> 5 & 1];
    }

    public write_g8(value): void
    {
        this.reg8[this.modrm_byte >> 1 & 0xC | this.modrm_byte >> 5 & 1] = value;
    }

    public read_g16(): any
    {
        return this.reg16[this.modrm_byte >> 2 & 14];
    }

    public read_g16s(): any
    {
        return this.reg16s[this.modrm_byte >> 2 & 14];
    }

    public write_g16(value): any
    {
        this.reg16[this.modrm_byte >> 2 & 14] = value;
    }

    public read_g32s(): any
    {
        return this.reg32s[this.modrm_byte >> 3 & 7];
    }

    public write_g32(value): void
    {
        this.reg32[this.modrm_byte >> 3 & 7] = value;
    }

    public pic_call_irq(int): void
    {
        try
        {
            this.previous_ip = this.instruction_pointer;
            this.call_interrupt_vector(int, false, false);
        }
        catch(e)
        {
            this.exception_cleanup(e);
        }
    }

    public handle_irqs(): void
    {
        dbg_assert(!this.page_fault);

        this.diverged();

        if((this.flags & flag_interrupt) && !this.page_fault)
        {
            if(this.devices.pic)
            {
                this.devices.pic.check_irqs();
            }

            if(this.devices.apic)
            {
                this.devices.apic.check_irqs();
            }
        }
    }

    public device_raise_irq(i): void
    {
        dbg_assert(arguments.length === 1);
        if(this.devices.pic)
        {
            this.devices.pic.set_irq(i);
        }

        if(this.devices.apic)
        {
            //this.devices.apic.set_irq(i);
            throw "wat";
        }
    }

    public device_lower_irq(i): void
    {
        if(this.devices.pic)
        {
            this.devices.pic.clear_irq(i);
        }

        if(this.devices.apic)
        {
            //this.devices.apic.clear_irq(i);
            throw "wat";
        }
    }

    public test_privileges_for_io(port, size): void
    {
        if(this.protected_mode && (this.cpl > this.getiopl() || (this.flags & flag_vm)))
        {
            var tsr_size = this.segment_limits[reg_tr],
                tsr_offset = this.segment_offsets[reg_tr];

            if(tsr_size >= 0x67)
            {
                dbg_assert((tsr_offset + 0x64 + 2 & 0xFFF) < 0xFFF);

                var iomap_base = this.read16(this.translate_address_system_read(tsr_offset + 0x64 + 2 | 0)),
                    high_port = port + size - 1 | 0;

                if(tsr_size >= (iomap_base + (high_port >> 3) | 0))
                {
                    var mask = ((1 << size) - 1) << (port & 7),
                        addr = this.translate_address_system_read(tsr_offset + iomap_base + (port >> 3) | 0),
                        port_info = (mask & 0xFF00) ?
                            this.read16(addr) : this.read8(addr);

                    dbg_assert((addr & 0xFFF) < 0xFFF);

                    if(!(port_info & mask))
                    {
                        return;
                    }
                }
            }

            dbg_log("#GP for port io  port=" + h(port) + " size=" + size, LOG_CPU);
            CPU_LOG_VERBOSE && this.debug.dump_state();
            this.trigger_gp(0);
        }
    }

    public cpuid(): void
    {
        // cpuid
        // TODO: Fill in with less bogus values

        // http://lxr.linux.no/linux+%2a/arch/x86/include/asm/cpufeature.h
        // http://www.sandpile.org/x86/cpuid.htm

        var eax = 0,
            ecx = 0,
            edx = 0,
            ebx = 0;

        var winnt_fix = false;

        switch(this.reg32s[reg_eax])
        {
            case 0:
                // maximum supported level
                if(winnt_fix)
                {
                    eax = 2;
                }
                else
                {
                    eax = 5;
                }

                ebx = 0x756E6547|0; // Genu
                edx = 0x49656E69|0; // ineI
                ecx = 0x6C65746E|0; // ntel
                break;

            case 1:
                // pentium
                eax = 3 | 6 << 4 | 15 << 8;
                ebx = 1 << 16 | 8 << 8; // cpu count, clflush size
                ecx = 1 << 23 | 1 << 30; // popcnt, rdrand
                var vme = 0 << 1;
                edx = (this.fpu ? 1 : 0) |                // fpu
                        vme | 1 << 3 | 1 << 4 | 1 << 5 |   // vme, pse, tsc, msr
                        1 << 8 | 1 << 11 | 1 << 13 | 1 << 15; // cx8, sep, pge, cmov

                if(ENABLE_ACPI)
                {
                    edx |= 1 << 9; // apic
                }
                break;

            case 2:
                // Taken from http://siyobik.info.gf/main/reference/instruction/CPUID
                eax = 0x665B5001|0;
                ebx = 0;
                ecx = 0;
                edx = 0x007A7000;
                break;

            case 4:
                // from my local machine
                switch(this.reg32s[reg_ecx])
                {
                    case 0:
                        eax = 0x00000121;
                        ebx = 0x01c0003f;
                        ecx = 0x0000003f;
                        edx = 0x00000001;
                        break;
                    case 1:
                        eax = 0x00000122;
                        ebx = 0x01c0003f;
                        ecx = 0x0000003f;
                        edx = 0x00000001;
                        break
                    case 2:
                        eax = 0x00000143;
                        ebx = 0x05c0003f;
                        ecx = 0x00000fff;
                        edx = 0x00000001;
                        break;
                }
                break;

            case 0x80000000|0:
                // maximum supported extended level
                eax = 5;
                // other registers are reserved
                break;

            default:
                dbg_log("cpuid: unimplemented eax: " + h(this.reg32[reg_eax]), LOG_CPU);
        }

        dbg_log("cpuid: eax=" + h(this.reg32[reg_eax], 8) + " cl=" + h(this.reg8[reg_cl], 2), LOG_CPU);

        this.reg32s[reg_eax] = eax;
        this.reg32s[reg_ecx] = ecx;
        this.reg32s[reg_edx] = edx;
        this.reg32s[reg_ebx] = ebx;
    }

    public update_cs_size(new_size): void
    {
        //dbg_log("Cleared due to cs size change, size=" + this.instruction_cache_size);
        this.clear_instruction_cache();
        CACHED_STATS && stats.clears_size++;

        this.is_32 = new_size;

        this.update_operand_size();
    }

    public update_operand_size(): void
    {
        if(this.is_32)
        {
            this.table = table32;
        }
        else
        {
            this.table = table16;
        }
    }

    public lookup_segment_selector(selector: number): any
    {
        dbg_assert(typeof selector === "number" && selector >= 0 && selector < 0x10000);

        var is_gdt = (selector & 4) === 0,
            selector_offset = selector & ~7,
            info,
            table_offset,
            table_limit;

        info = {
            rpl: selector & 3,
            from_gdt: is_gdt,
            is_null: false,
            is_valid: true,

            base: 0,
            access: 0,
            flags: 0,
            type: 0,
            dpl: 0,
            is_system: false,
            is_present: false,
            is_executable: false,
            rw_bit: false,
            dc_bit: false,
            size: false,

            is_conforming_executable: false,

            // limit after applying granularity
            effective_limit: 0,

            is_writable: false,
            is_readable: false,
            table_offset: 0,

            raw0: 0,
            raw1: 0,
        };

        if(is_gdt)
        {
            table_offset = this.gdtr_offset;
            table_limit = this.gdtr_size;
        }
        else
        {
            table_offset = this.segment_offsets[reg_ldtr];
            table_limit = this.segment_limits[reg_ldtr];
        }

        if(selector_offset === 0)
        {
            info.is_null = true;
            return info;
        }

        // limit is the number of entries in the table minus one
        if((selector | 7) > table_limit)
        {
            dbg_log("Selector " + h(selector, 4) + " is outside of the "
                        + (is_gdt ? "g" : "l") + "dt limits", LOG_CPU)
            info.is_valid = false;
            return info;
        }

        table_offset = table_offset + selector_offset | 0;

        if(this.paging)
        {
            table_offset = this.translate_address_system_read(table_offset);
        }
        info.table_offset = table_offset;

        info.base = this.read16(table_offset + 2 | 0) | this.read8(table_offset + 4 | 0) << 16 |
                    this.read8(table_offset + 7 | 0) << 24;
        info.access = this.read8(table_offset + 5 | 0);
        info.flags = this.read8(table_offset + 6 | 0) >> 4;

        info.raw0 = this.read32s(table_offset     | 0);
        info.raw1 = this.read32s(table_offset + 4 | 0);

        //this.write8(table_offset + 5 | 0, info.access | 1);

        // used if system
        info.type = info.access & 0xF;

        info.dpl = info.access >> 5 & 3;

        info.is_system = (info.access & 0x10) === 0;
        info.is_present = (info.access & 0x80) === 0x80;
        info.is_executable = (info.access & 8) === 8;

        info.rw_bit = (info.access & 2) === 2;
        info.dc_bit = (info.access & 4) === 4;

        info.is_conforming_executable = info.dc_bit && info.is_executable;

        info.size = (info.flags & 4) === 4;

        var limit = this.read16(table_offset) |
                    (this.read8(table_offset + 6 | 0) & 0xF) << 16;

        if(info.flags & 8)
        {
            // granularity set
            info.effective_limit = (limit << 12 | 0xFFF) >>> 0;
        }
        else
        {
            info.effective_limit = limit;
        }

        info.is_writable = info.rw_bit && !info.is_executable;
        info.is_readable = info.rw_bit || !info.is_executable;

        return info;
    }

    public switch_seg(reg: number, selector: number): void
    {
        dbg_assert(reg >= 0 && reg <= 5);
        dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

        if(!this.protected_mode || this.vm86_mode())
        {
            this.sreg[reg] = selector;
            this.segment_is_null[reg] = 0;
            this.segment_offsets[reg] = selector << 4;

            if(reg === reg_ss)
            {
                this.stack_size_32 = false;
            }
            return;
        }

        var info = this.lookup_segment_selector(selector);

        if(reg === reg_ss)
        {
            if(info.is_null)
            {
                dbg_log("#GP for loading 0 in SS sel=" + h(selector, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_gp(0);
            }

            if(!info.is_valid ||
            info.is_system ||
            info.rpl !== this.cpl ||
            !info.is_writable ||
            info.dpl !== this.cpl)
            {
                dbg_log("#GP for loading invalid in SS sel=" + h(selector, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                //debugger;
                this.trigger_gp(selector & ~3);
            }

            if(!info.is_present)
            {
                dbg_log("#SS for loading non-present in SS sel=" + h(selector, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_ss(selector & ~3);
            }

            this.stack_size_32 = info.size;
        }
        else if(reg === reg_cs)
        {
            // handled by switch_cs_real_mode, far_return or far_jump
            dbg_assert(false);
        }
        else
        {
            // es, ds, fs, gs
            if(info.is_null)
            {
                //dbg_log("0 loaded in seg=" + reg + " sel=" + h(selector, 4), LOG_CPU);
                //dbg_trace(LOG_CPU);
                this.sreg[reg] = selector;
                this.segment_is_null[reg] = 1;
                return;
            }

            if(!info.is_valid ||
            info.is_system ||
            !info.is_readable ||
            (!info.is_conforming_executable &&
                (info.rpl > info.dpl || this.cpl > info.dpl))
            ) {
                dbg_log("#GP for loading invalid in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
                this.debug.dump_state();
                this.debug.dump_regs_short();
                dbg_trace(LOG_CPU);
                //debugger;
                this.trigger_gp(selector & ~3);
            }

            if(!info.is_present)
            {
                dbg_log("#NP for loading not-present in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
                dbg_trace(LOG_CPU);
                this.trigger_np(selector & ~3);
            }
        }

        this.segment_is_null[reg] = 0;
        this.segment_limits[reg] = info.effective_limit;
        //this.segment_infos[reg] = 0; // TODO

        this.segment_offsets[reg] = info.base;
        this.sreg[reg] = selector;
    }

    public load_tr(selector): void
    {
        var info = this.lookup_segment_selector(selector);

        dbg_assert(info.is_valid);
        //dbg_log("load tr: " + h(selector, 4) + " offset=" + h(info.base >>> 0, 8) + " limit=" + h(info.effective_limit >>> 0, 8), LOG_CPU);

        if(!info.from_gdt)
        {
            throw this.debug.unimpl("TR can only be loaded from GDT");
        }

        if(info.is_null)
        {
            dbg_log("#GP(0) | tried to load null selector (ltr)");
            throw this.debug.unimpl("#GP handler");
        }

        if(!info.is_present)
        {
            dbg_log("#GP | present bit not set (ltr)");
            throw this.debug.unimpl("#GP handler");
        }

        if(!info.is_system)
        {
            dbg_log("#GP | ltr: not a system entry");
            throw this.debug.unimpl("#GP handler");
        }

        if(info.type !== 9 && info.type !== 1)
        {
            // 0xB: busy 386 TSS (GP)
            // 0x3: busy 286 TSS (GP)
            // 0x1: 286 TSS (??)
            dbg_log("#GP | ltr: invalid type (type = " + h(info.type) + ")");
            throw this.debug.unimpl("#GP handler");
        }

        if(info.type === 1)
        {
            // 286 tss: Load 16 bit values from tss in call_interrupt_vector
            throw this.debug.unimpl("286 tss");
        }

        this.segment_offsets[reg_tr] = info.base;
        this.segment_limits[reg_tr] = info.effective_limit;
        this.sreg[reg_tr] = selector;

        // Mark task as busy
        this.write8(info.table_offset + 5 | 0, this.read8(info.table_offset + 5 | 0) | 2);

        //dbg_log("tsr at " + h(info.base) + "; (" + info.effective_limit + " bytes)");
    }

    public load_ldt(selector): void
    {
        var info = this.lookup_segment_selector(selector);

        if(info.is_null)
        {
            // invalid
            this.segment_offsets[reg_ldtr] = 0;
            this.segment_limits[reg_ldtr] = 0;
            return;
        }

        dbg_assert(info.is_valid);

        if(!info.from_gdt)
        {
            throw this.debug.unimpl("LDTR can only be loaded from GDT");
        }

        if(!info.is_present)
        {
            dbg_log("lldt: present bit not set");
            throw this.debug.unimpl("#GP handler");
        }

        if(!info.is_system)
        {
            dbg_log("lldt: not a system entry");
            throw this.debug.unimpl("#GP handler");
        }

        if(info.type !== 2)
        {
            dbg_log("lldt: invalid type (" + info.type + ")");
            throw this.debug.unimpl("#GP handler");
        }

        this.segment_offsets[reg_ldtr] = info.base;
        this.segment_limits[reg_ldtr] = info.effective_limit;
        this.sreg[reg_ldtr] = selector;

        //dbg_log("ldt at " + h(info.base >>> 0) + "; (" + info.effective_limit + " bytes)", LOG_CPU);
    }

    public arpl(seg, r16): number
    {
        this.flags_changed &= ~flag_zero;

        if((seg & 3) < (this.reg16[r16] & 3))
        {
            this.flags |= flag_zero;
            return seg & ~3 | this.reg16[r16] & 3;
        }
        else
        {
            this.flags &= ~flag_zero;
            return seg;
        }
    }

    public lar(selector, original): number
    {
        /** @const */
        var LAR_INVALID_TYPE = 1 << 0 | 1 << 6 | 1 << 7 | 1 << 8 | 1 << 0xA |
                            1 << 0xD | 1 << 0xE | 1 << 0xF;

        var info = this.lookup_segment_selector(selector);
        this.flags_changed &= ~flag_zero;

        var dpl_bad = info.dpl < this.cpl || info.dpl < info.rpl;

        if(info.is_null || !info.is_valid ||
        (info.is_system ? (LAR_INVALID_TYPE >> info.type & 1) || dpl_bad :
                            !info.is_conforming_executable && dpl_bad)
        ) {
            this.flags &= ~flag_zero;
            dbg_log("lar: invalid selector=" + h(selector, 4) + " is_null=" + info.is_null, LOG_CPU);
            return original;
        }
        else
        {
            this.flags |= flag_zero;
            return info.raw1 & 0x00FFFF00;
        }
    }

    public lsl(selector, original): number
    {
        /** @const */
        var LSL_INVALID_TYPE = 1 << 0 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 8 |
                            1 << 0xA | 1 << 0xC | 1 << 0xD | 1 << 0xE | 1 << 0xF;

        var info = this.lookup_segment_selector(selector);
        this.flags_changed &= ~flag_zero;

        var dpl_bad = info.dpl < this.cpl || info.dpl < info.rpl;

        if(info.is_null || !info.is_valid ||
        (info.is_system ? (LSL_INVALID_TYPE >> info.type & 1) || dpl_bad :
                            !info.is_conforming_executable && dpl_bad)
        ) {
            this.flags &= ~flag_zero;
            dbg_log("lsl: invalid  selector=" + h(selector, 4) + " is_null=" + info.is_null, LOG_CPU);
            return original;
        }
        else
        {
            this.flags |= flag_zero;
            return info.effective_limit | 0;
        }
    }

    public verr(selector): void
    {
        var info = this.lookup_segment_selector(selector);
        this.flags_changed &= ~flag_zero;

        if(info.is_null || !info.is_valid || info.is_system || !info.is_readable ||
        (!info.is_conforming_executable && (info.dpl < this.cpl || info.dpl < info.rpl)))
        {
            dbg_log("verr -> invalid. selector=" + h(selector, 4), LOG_CPU);
            this.flags &= ~flag_zero;
        }
        else
        {
            dbg_log("verr -> valid. selector=" + h(selector, 4), LOG_CPU);
            this.flags |= flag_zero;
        }
    }

    public verw(selector): void
    {
        var info = this.lookup_segment_selector(selector);
        this.flags_changed &= ~flag_zero;

        if(info.is_null || !info.is_valid || info.is_system || !info.is_writable ||
        info.dpl < this.cpl || info.dpl < info.rpl)
        {
            dbg_log("verw invalid " + " " + h(selector) + " " + info.is_null + " " +
                    !info.is_valid + " " + info.is_system + " " + !info.is_writable + " " +
                    (info.dpl < this.cpl) + " " + (info.dpl < info.rpl) + " " + LOG_CPU);
            this.flags &= ~flag_zero;
        }
        else
        {
            this.flags |= flag_zero;
        }
    }

    public clear_tlb(): void
    {
        // clear tlb excluding global pages
        this.last_virt_eip = -1;
        this.last_virt_esp = -1;

        this.tlb_info.set(this.tlb_info_global);

        //dbg_log("page table loaded", LOG_CPU);
    }

    public full_clear_tlb(): void
    {
        //dbg_log("TLB full clear", LOG_CPU);

        // clear tlb including global pages
        var buf32 = new Int32Array(this.tlb_info_global.buffer);
        for(var i = 0; i < (1 << 18); )
        {
            buf32[i++] = buf32[i++] = buf32[i++] = buf32[i++] = 0;
        }

        this.clear_tlb();
    }

    public invlpg(addr): void
    {
        var page = addr >>> 12;
        //dbg_log("invlpg: addr=" + h(addr >>> 0), LOG_CPU);

        this.tlb_info[page] = 0;
        this.tlb_info_global[page] = 0;

        this.last_virt_eip = -1;
        this.last_virt_esp = -1;
    }

    public translate_address_read(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        if(this.cpl === 3)
        {
            return this.translate_address_user_read(addr);
        }
        else
        {
            return this.translate_address_system_read(addr);
        }
    }

    public translate_address_write(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        if(this.cpl === 3)
        {
            return this.translate_address_user_write(addr);
        }
        else
        {
            return this.translate_address_system_write(addr);
        }
    }

    public translate_address_user_write(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        var base = addr >>> 12;

        if(this.tlb_info[base] & TLB_USER_WRITE)
        {
            return this.tlb_data[base] ^ addr;
        }
        else
        {
            return this.do_page_translation(addr, 1, 1) | addr & 0xFFF;
        }
    }

    public translate_address_user_read(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        var base = addr >>> 12;

        if(this.tlb_info[base] & TLB_USER_READ)
        {
            return this.tlb_data[base] ^ addr;
        }
        else
        {
            return this.do_page_translation(addr, 0, 1) | addr & 0xFFF;
        }
    }

    public translate_address_system_write(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        var base = addr >>> 12;

        if(this.tlb_info[base] & TLB_SYSTEM_WRITE)
        {
            return this.tlb_data[base] ^ addr;
        }
        else
        {
            return this.do_page_translation(addr, 1, 0) | addr & 0xFFF;
        }
    }

    public translate_address_system_read(addr): number
    {
        if(!this.paging)
        {
            return addr;
        }

        var base = addr >>> 12;

        if(this.tlb_info[base] & TLB_SYSTEM_READ)
        {
            return this.tlb_data[base] ^ addr;
        }
        else
        {
            return this.do_page_translation(addr, 0, 0) | addr & 0xFFF;
        }
    }

    public do_page_translation(addr, for_writing, user): number
    {
        var page = addr >>> 12,
            page_dir_addr = (this.cr[3] >>> 2) + (page >> 10) | 0,
            page_dir_entry = this.mem32s[page_dir_addr],
            high: number,
            can_write = true,
            global,
            cachable = true,
            allow_user = true;

        dbg_assert(addr < 0x80000000);

        if(!(page_dir_entry & 1))
        {
            // to do at this place:
            //
            // - set cr2 = addr (which caused the page fault)
            // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
            // - prevent execution of the function that triggered this call
            //dbg_log("#PF not present", LOG_CPU);

            this.cr[2] = addr;
            this.trigger_pagefault(for_writing, user, 0);

            // never reached as this.trigger_pagefault throws up
            dbg_assert(false);
        }

        if((page_dir_entry & 2) === 0)
        {
            can_write = false;

            if(for_writing && (user || (this.cr[0] & CR0_WP)))
            {
                this.cr[2] = addr;
                this.trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_dir_entry & 4) === 0)
        {
            allow_user = false;

            if(user)
            {
                // "Page Fault: page table accessed by non-supervisor";
                //dbg_log("#PF supervisor", LOG_CPU);
                this.cr[2] = addr;
                this.trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if(page_dir_entry & this.page_size_extensions)
        {
            // size bit is set

            // set the accessed and dirty bits
            this.mem32s[page_dir_addr] = page_dir_entry | 0x20 | for_writing << 6;

            high = (page_dir_entry & 0xFFC00000) | (addr & 0x3FF000);
            global = page_dir_entry & 0x100;
        }
        else
        {
            var page_table_addr = ((page_dir_entry & 0xFFFFF000) >>> 2) + (page & 0x3FF) | 0,
                page_table_entry = this.mem32s[page_table_addr];

            if((page_table_entry & 1) === 0)
            {
                //dbg_log("#PF not present table", LOG_CPU);
                this.cr[2] = addr;
                this.trigger_pagefault(for_writing, user, 0);
                dbg_assert(false);
            }

            if((page_table_entry & 2) === 0)
            {
                can_write = false;

                if(for_writing && (user || (this.cr[0] & CR0_WP)))
                {
                    //dbg_log("#PF not writable page", LOG_CPU);
                    this.cr[2] = addr;
                    this.trigger_pagefault(for_writing, user, 1);
                    dbg_assert(false);
                }
            }

            if((page_table_entry & 4) === 0)
            {
                allow_user = false;

                if(user)
                {
                    //dbg_log("#PF not supervisor page", LOG_CPU);
                    this.cr[2] = addr;
                    this.trigger_pagefault(for_writing, user, 1);
                    dbg_assert(false);
                }
            }

            // set the accessed and dirty bits
            this.write_aligned32(page_dir_addr, page_dir_entry | 0x20);
            this.write_aligned32(page_table_addr, page_table_entry | 0x20 | for_writing << 6);

            high = page_table_entry & 0xFFFFF000;
            global = page_table_entry & 0x100;
        }

        this.tlb_data[page] = high ^ page << 12;

        var allowed_flag;

        if(allow_user)
        {
            if(can_write)
            {
                allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE | TLB_USER_READ | TLB_USER_WRITE;
            }
            else
            {
                // TODO: Consider if cr0.wp is not set
                allowed_flag = TLB_SYSTEM_READ | TLB_USER_READ;
            }
        }
        else
        {
            if(can_write)
            {
                allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE;
            }
            else
            {
                allowed_flag = TLB_SYSTEM_READ;
            }
        }

        this.tlb_info[page] = allowed_flag;

        if(global && (this.cr[4] & CR4_PGE))
        {
            this.tlb_info_global[page] = allowed_flag;
        }

        return high;
    }

    /** @param {*=} cpl */
    public writable_or_pagefault(addr, size, cpl?): void
    {
        dbg_assert(size < 0x1000, "not supported yet");
        dbg_assert(size > 0);

        if(!this.paging)
        {
            return;
        }

        var user = (cpl === undefined ? this.cpl : cpl) === 3 ? 1 : 0,
            mask = user ? TLB_USER_WRITE : TLB_SYSTEM_WRITE,
            page = addr >>> 12;

        if((this.tlb_info[page] & mask) === 0)
        {
            this.do_page_translation(addr, 1, user);
        }

        if((addr & 0xFFF) + size - 1 >= 0x1000)
        {
            if((this.tlb_info[page + 1 | 0] & mask) === 0)
            {
                this.do_page_translation(addr + size - 1 | 0, 1, user);
            }
        }
    }

    public trigger_pagefault(write, user, present): void
    {
        dbg_log("page fault w=" + write + " u=" + user + " p=" + present +
                " eip=" + h(this.previous_ip >>> 0, 8) +
                " cr2=" + h(this.cr[2] >>> 0, 8), LOG_CPU);
        dbg_trace(LOG_CPU);

        if(this.page_fault)
        {
            dbg_trace(LOG_CPU);
            throw this.debug.unimpl("Double fault");
        }

        // invalidate tlb entry
        var page = this.cr[2] >>> 12;

        this.tlb_info[page] = 0;
        this.tlb_info_global[page] = 0;

        this.instruction_pointer = this.previous_ip;
        this.page_fault = true;
        this.call_interrupt_vector(14, false, user << 2 | write << 1 | present);

        throw MAGIC_CPU_EXCEPTION;
    }

    public is_osize_32(): boolean
    {
        return this.is_32 !== ((this.prefixes & PREFIX_MASK_OPSIZE) === PREFIX_MASK_OPSIZE);
    }

    public is_asize_32(): boolean
    {
        return this.is_32 !== ((this.prefixes & PREFIX_MASK_ADDRSIZE) === PREFIX_MASK_ADDRSIZE);
    }

    public get_reg_asize(reg): number
    {
        dbg_assert(reg === reg_ecx || reg === reg_esi || reg === reg_edi);
        var r = this.reg32s[reg];

        if(this.is_asize_32())
        {
            return r;
        }
        else
        {
            return r & 0xFFFF;
        }
    }

    public set_ecx_asize(value): void
    {
        if(this.is_asize_32())
        {
            this.reg32s[reg_ecx] = value;
        }
        else
        {
            this.reg16[reg_cx] = value;
        }
    }

    public add_reg_asize(reg, value): void
    {
        dbg_assert(reg === reg_ecx || reg === reg_esi || reg === reg_edi);
        if(this.is_asize_32())
        {
            this.reg32s[reg] += value;
        }
        else
        {
            this.reg16[reg << 1] += value;
        }
    }

    public decr_ecx_asize(): number
    {
        return this.is_asize_32() ? --this.reg32s[reg_ecx] : --this.reg16[reg_cx];
    }

    // former memory.ts

    private readonly A20_MASK = ~(1 << 20);
    private readonly A20_MASK16 = ~(1 << 20 - 1);
    private readonly A20_MASK32 = ~(1 << 20 - 2);
    private readonly USE_A20 = false;

    public check_write_page(page: any): any
    {}

    public check_write2(addr: number, size: number): any
    {}

    public check_write_range(addr: number, size: number): any
    {}

    // called by all memory writes
    public debug_write(addr: number, size: number, value: number): void
    {
        if(!DEBUG)
        {
            return;
        }

        dbg_assert(typeof value === "number" && !isNaN(value));
        dbg_assert(value >= -0x80000000 && addr < 0x80000000);

        //if((addr >>> 0) >= 0xDBCF60 && (addr >>> 0) < 0xDBCF90)
        //{
        //    dbg_log("write " + h(value >>> 0, 8) + " to " + h(addr >>> 0, 8) + " at " + h(this.instruction_pointer >>> 0));
        //    dbg_trace();
        //}

        //dbg_log("Write " + size + " bytes to " + h(addr >>> 0, 8));
        this.debug_read(addr, size, true);
    }

    public debug_read(addr: number, size: number, is_write?: boolean): void
    {
        if(!DEBUG)
        {
            return;
        }

        dbg_assert(typeof addr === "number");
        dbg_assert(!isNaN(addr));
    }


    public mmap_read8(addr: number): number
    {
        return this.memory_map_read8[addr >>> MMAP_BLOCK_BITS](addr);
    }

    public mmap_write8(addr: number, value: number): void
    {
        this.memory_map_write8[addr >>> MMAP_BLOCK_BITS](addr, value);
    }

    public mmap_read16(addr: number): number
    {
        var fn = this.memory_map_read8[addr >>> MMAP_BLOCK_BITS];

        return fn(addr) | fn(addr + 1 | 0) << 8;
    }

    public mmap_write16(addr: number, value: number): void
    {
        var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];
        //console.log("write16");

        fn(addr, value & 0xFF);
        fn(addr + 1 | 0, value >> 8 & 0xFF);
    }

    public mmap_read32(addr: number): number
    {
        var aligned_addr = addr >>> MMAP_BLOCK_BITS;

        return this.memory_map_read32[aligned_addr](addr);
    }

    public mmap_write32(addr: number, value: number): void
    {
        var aligned_addr = addr >>> MMAP_BLOCK_BITS;
        //console.log("write32");

        this.memory_map_write32[aligned_addr](addr, value);
    }

    public in_mapped_range(addr: number): boolean
    {
        return (addr | 0) >= 0xA0000 && (addr | 0) < 0xC0000 || (addr >>> 0) >= (this.memory_size >>> 0);
    }

    public read8(addr: number): number
    {
        this.debug_read(addr, 1);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        if(this.in_mapped_range(addr))
        {
            return this.mmap_read8(addr);
        }
        else
        {
            return this.mem8[addr];
        }
    };

    public read16(addr: number): number
    {
        this.debug_read(addr, 2);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        if(this.in_mapped_range(addr))
        {
            return this.mmap_read16(addr);
        }
        else
        {
            return this.mem8[addr] | this.mem8[addr + 1 | 0] << 8;
        }
    }

    public read_aligned16(addr: number): number
    {
        dbg_assert(addr >= 0 && addr < 0x80000000);
        this.debug_read(addr << 1, 2);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK16;

        if(this.in_mapped_range(addr << 1))
        {
            return this.mmap_read16(addr << 1);
        }
        else
        {
            return this.mem16[addr];
        }
    }

    public read32s(addr: number): number
    {
        this.debug_read(addr, 4);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        if(this.in_mapped_range(addr))
        {
            return this.mmap_read32(addr);
        }
        else
        {
            return this.mem8[addr] | this.mem8[addr + 1 | 0] << 8 |
                this.mem8[addr + 2 | 0] << 16 | this.mem8[addr + 3 | 0] << 24;
        }
    }

    public read_aligned32(addr: number): number
    {
        dbg_assert(addr >= 0 && addr < 0x40000000);
        this.debug_read(addr << 2, 4);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK32;

        if(this.in_mapped_range(addr << 2))
        {
            return this.mmap_read32(addr << 2);
        }
        else
        {
            return this.mem32s[addr];
        }
    }

    public write8(addr: number, value: number): void
    {
        this.debug_write(addr, 1, value);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        this.check_write_page(addr >>> 12);
        //this.mem_page_infos[addr >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;

        if(this.in_mapped_range(addr))
        {
            this.mmap_write8(addr, value);
        }
        else
        {
            this.mem8[addr] = value;
        }
    }

    public write16(addr: number, value: number)
    {
        this.debug_write(addr, 2, value);
        this.check_write2(addr, 2);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        //this.mem_page_infos[addr >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
        //this.mem_page_infos[addr + 1 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;

        if(this.in_mapped_range(addr))
        {
            this.mmap_write16(addr, value);
        }
        else
        {
            this.mem8[addr] = value;
            this.mem8[addr + 1 | 0] = value >> 8;
        }
    }

    public write_aligned16(addr: number, value: number): void
    {
        dbg_assert(addr >= 0 && addr < 0x80000000);
        this.debug_write(addr << 1, 2, value);
        this.check_write_page(addr >> 12 - 1);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK16;

        //this.mem_page_infos[addr >>> MMAP_BLOCK_BITS - 1] |= MEM_PAGE_WRITTEN;

        if(this.in_mapped_range(addr << 1))
        {
            this.mmap_write16(addr << 1, value);
        }
        else
        {
            this.mem16[addr] = value;
        }
    }

    public write32(addr: number, value: number): void
    {
        this.debug_write(addr, 4, value);
        this.check_write2(addr, 4);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK;

        //this.mem_page_infos[addr >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
        //this.mem_page_infos[addr + 3 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;

        if(this.in_mapped_range(addr))
        {
            this.mmap_write32(addr, value);
        }
        else
        {
            this.mem8[addr] = value;
            this.mem8[addr + 1 | 0] = value >> 8;
            this.mem8[addr + 2 | 0] = value >> 16;
            this.mem8[addr + 3 | 0] = value >> 24;
        }
    }

    public write_aligned32(addr, value): void
    {
        dbg_assert(addr >= 0 && addr < 0x40000000);
        this.debug_write(addr << 2, 4, value);
        this.check_write_page(addr >> 12 - 2);
        if(this.USE_A20 && !this.a20_enabled) addr &= this.A20_MASK32;

        //this.mem_page_infos[addr >>> MMAP_BLOCK_BITS - 2] |= MEM_PAGE_WRITTEN;

        if(this.in_mapped_range(addr << 2))
        {
            this.mmap_write32(addr << 2, value);
        }
        else
        {
            this.mem32s[addr] = value;
        }
    }

    public write_blob(blob: number[] | Uint8Array, offset: number): void
    {
        this.debug_write(offset, blob.length, 0)
        this.check_write_range(offset, blob.length);
        dbg_assert(blob && blob.length >= 0);

        this.mem8.set(blob, offset);
    }

    public write_blob32(blob: number[] | Int32Array, offset: number): void
    {
        dbg_assert(!!(blob && blob.length));
        this.debug_write(offset, blob.length << 2, 0);
        this.check_write_range(offset, blob.length << 2);
        this.mem32s.set(blob, offset);
    }

    // former misc_instr.ts
    /*
    * Some miscellaneous instructions:
    *
    * jmpcc16, jmpcc32, jmp16
    * loop, loope, loopne, jcxz
    * test_cc
    *
    * mov, push, pop
    * pusha, popa
    * xchg, lss
    * lea
    * enter
    * bswap
    */


    public jmpcc8(condition: boolean): void
    {
        var imm8 = this.read_op8s();
        if(condition)
        {
            this.instruction_pointer = this.instruction_pointer + imm8 | 0;
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public jmp_rel16(rel16: number): void
    {
        var current_cs = this.get_seg(reg_cs);

        // limit ip to 16 bit
        // ugly
        this.instruction_pointer -= current_cs;
        this.instruction_pointer = (this.instruction_pointer + rel16) & 0xFFFF;
        this.instruction_pointer = this.instruction_pointer + current_cs | 0;
    };

    public jmpcc16(condition: boolean): void
    {
        var imm16 = this.read_op16();
        if(condition)
        {
            this.jmp_rel16(imm16);
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public jmpcc32(condition: boolean): void
    {
        var imm32s = this.read_op32s();
        if(condition)
        {
            // don't change to `this.instruction_pointer += this.read_op32s()`,
            //   since read_op32s modifies instruction_pointer

            this.instruction_pointer = this.instruction_pointer + imm32s | 0;
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public cmovcc16(condition: boolean): void
    {
        var data = this.read_e16();
        if(condition)
        {
            this.write_g16(data);
        }
    }

    public cmovcc32(condition: boolean): void
    {
        var data = this.read_e32s();
        if(condition)
        {
            this.write_g32(data);
        }
    }

    public setcc(condition: boolean): void
    {
        this.set_e8(condition ? 1 : 0)
    }

    public loopne(imm8s: number): void
    {
        if(this.decr_ecx_asize() && !this.getzf())
        {
            this.instruction_pointer = this.instruction_pointer + imm8s | 0;
            //if(!this.operand_size_32) dbg_assert(this.get_real_eip() <= 0xffff);
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public loope(imm8s: number): void
    {
        if(this.decr_ecx_asize() && this.getzf())
        {
            this.instruction_pointer = this.instruction_pointer + imm8s | 0;
            //if(!this.operand_size_32) dbg_assert(this.get_real_eip() <= 0xffff);
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public loop(imm8s: number): void
    {
        if(this.decr_ecx_asize())
        {
            this.instruction_pointer = this.instruction_pointer + imm8s | 0;
            //if(!this.operand_size_32) dbg_assert(this.get_real_eip() <= 0xffff);
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public jcxz(imm8s: number): void
    {
        if(this.get_reg_asize(reg_ecx) === 0)
        {
            this.instruction_pointer = this.instruction_pointer + imm8s | 0;
            //if(!this.operand_size_32) dbg_assert(this.get_real_eip() <= 0xffff);
            this.branch_taken();
        }
        else
        {
            this.branch_not_taken();
        }
    }

    public getcf(): number
    {
        if(this.flags_changed & 1)
        {
            return (this.last_op1 ^ (this.last_op1 ^ this.last_op2) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
        }
        else
        {
            return this.flags & 1;
        }
    }

    public getpf(): number
    {
        if(this.flags_changed & flag_parity)
        {
            // inverted lookup table
            return 0x9669 << 2 >> ((this.last_result ^ this.last_result >> 4) & 0xF) & flag_parity;
        }
        else
        {
            return this.flags & flag_parity;
        }
    }

    public getaf(): number
    {
        if(this.flags_changed & flag_adjust)
        {
            return (this.last_op1 ^ this.last_op2 ^ this.last_add_result) & flag_adjust;
        }
        else
        {
            return this.flags & flag_adjust;
        }
    }

    public getzf(): number
    {
        if(this.flags_changed & flag_zero)
        {
            return (~this.last_result & this.last_result - 1) >>> this.last_op_size & 1;
        }
        else
        {
            return this.flags & flag_zero;
        }
    }

    public getsf(): number
    {
        if(this.flags_changed & flag_sign)
        {
            return this.last_result >>> this.last_op_size & 1;
        }
        else
        {
            return this.flags & flag_sign;
        }
    }

    public getof(): number
    {
        if(this.flags_changed & flag_overflow)
        {
            return ((this.last_op1 ^ this.last_add_result) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
        }
        else
        {
            return this.flags & flag_overflow;
        }
    };

    public test_o(): boolean { return !!this.getof(); }
    public test_b(): boolean { return !!this.getcf(); }
    public test_z(): boolean { return !!this.getzf(); }
    public test_s(): boolean { return !!this.getsf(); }
    public test_p(): boolean { return !!this.getpf(); }

    public test_be(): boolean
    {
        // Idea:
        //    return this.last_op1 <= this.last_op2;
        return !!this.getcf() || !!this.getzf();
    }

    public test_l(): boolean
    {
        // Idea:
        //    return this.last_add_result < this.last_op2;
        return !this.getsf() !== !this.getof();
    }

    public test_le(): boolean
    {
        // Idea:
        //    return this.last_add_result <= this.last_op2;
        return !!this.getzf() || !this.getsf() !== !this.getof();
    }



    public push16(imm16)
    {
        var sp = this.get_stack_pointer(-2);

        this.safe_write16(sp, imm16);
        this.adjust_stack_reg(-2);
    }

    public push32(imm32)
    {
        var sp = this.get_stack_pointer(-4);

        this.safe_write32(sp, imm32);
        this.adjust_stack_reg(-4);
    }

    public pop16()
    {
        var sp = this.get_seg(reg_ss) + this.get_stack_reg() | 0,
            result = this.safe_read16(sp);

        this.adjust_stack_reg(2);
        return result;
    }

    public pop32s()
    {
        var sp = this.get_seg(reg_ss) + this.get_stack_reg() | 0,
            result = this.safe_read32s(sp);

        this.adjust_stack_reg(4);
        return result;
    }

    public pusha16()
    {
        var temp = this.reg16[reg_sp];

        // make sure we don't get a pagefault after having
        // pushed several registers already
        //this.translate_address_write(this.get_stack_pointer(-15));
        this.writable_or_pagefault(this.get_stack_pointer(-16), 16)

        this.push16(this.reg16[reg_ax]);
        this.push16(this.reg16[reg_cx]);
        this.push16(this.reg16[reg_dx]);
        this.push16(this.reg16[reg_bx]);
        this.push16(temp);
        this.push16(this.reg16[reg_bp]);
        this.push16(this.reg16[reg_si]);
        this.push16(this.reg16[reg_di]);
    }

    public pusha32()
    {
        var temp = this.reg32s[reg_esp];

        //this.translate_address_write(this.get_stack_pointer(-31));
        this.writable_or_pagefault(this.get_stack_pointer(-32), 32)

        this.push32(this.reg32s[reg_eax]);
        this.push32(this.reg32s[reg_ecx]);
        this.push32(this.reg32s[reg_edx]);
        this.push32(this.reg32s[reg_ebx]);
        this.push32(temp);
        this.push32(this.reg32s[reg_ebp]);
        this.push32(this.reg32s[reg_esi]);
        this.push32(this.reg32s[reg_edi]);
    }

    public popa16()
    {
        this.translate_address_read(this.get_stack_pointer(0));
        this.translate_address_read(this.get_stack_pointer(15));

        this.reg16[reg_di] = this.pop16();
        this.reg16[reg_si] = this.pop16();
        this.reg16[reg_bp] = this.pop16();
        this.adjust_stack_reg(2);
        this.reg16[reg_bx] = this.pop16();
        this.reg16[reg_dx] = this.pop16();
        this.reg16[reg_cx] = this.pop16();
        this.reg16[reg_ax] = this.pop16();
    }

    public popa32()
    {
        this.translate_address_read(this.get_stack_pointer(0));
        this.translate_address_read(this.get_stack_pointer(31));

        this.reg32s[reg_edi] = this.pop32s();
        this.reg32s[reg_esi] = this.pop32s();
        this.reg32s[reg_ebp] = this.pop32s();
        this.adjust_stack_reg(4);
        this.reg32s[reg_ebx] = this.pop32s();
        this.reg32s[reg_edx] = this.pop32s();
        this.reg32s[reg_ecx] = this.pop32s();
        this.reg32s[reg_eax] = this.pop32s();
    }

    public xchg8(memory_data, modrm_byte)
    {
        var mod = modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1,
            tmp = this.reg8[mod];

        this.reg8[mod] = memory_data;

        return tmp;
    }

    public xchg16(memory_data, modrm_byte)
    {
        var mod = modrm_byte >> 2 & 14,
            tmp = this.reg16[mod];

        this.reg16[mod] = memory_data;

        return tmp;
    }

    public xchg16r(operand)
    {
        var temp = this.reg16[reg_ax];
        this.reg16[reg_ax] = this.reg16[operand];
        this.reg16[operand] = temp;
    }

    public xchg32(memory_data, modrm_byte)
    {
        var mod = modrm_byte >> 3 & 7,
            tmp = this.reg32s[mod];

        this.reg32s[mod] = memory_data;

        return tmp;
    }

    public xchg32r(operand)
    {
        var temp = this.reg32s[reg_eax];
        this.reg32s[reg_eax] = this.reg32s[operand];
        this.reg32s[operand] = temp;
    }

    public lss16(seg)
    {
        if(this.modrm_byte >= 0xC0)
        {
            this.trigger_ud();
        }

        var addr = this.modrm_resolve(this.modrm_byte);

        var new_reg = this.safe_read16(addr),
            new_seg = this.safe_read16(addr + 2 | 0);

        this.switch_seg(seg, new_seg);

        this.reg16[this.modrm_byte >> 2 & 14] = new_reg;
    }

    public lss32(seg)
    {
        if(this.modrm_byte >= 0xC0)
        {
            this.trigger_ud();
        }

        var addr = this.modrm_resolve(this.modrm_byte);

        var new_reg = this.safe_read32s(addr),
            new_seg = this.safe_read16(addr + 4 | 0);

        this.switch_seg(seg, new_seg);

        this.reg32s[this.modrm_byte >> 3 & 7] = new_reg;
    }

    public enter16(size, nesting_level)
    {
        nesting_level &= 31;

        if(nesting_level) dbg_log("enter16 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
        this.push16(this.reg16[reg_bp]);
        var frame_temp = this.reg16[reg_sp];

        if(nesting_level > 0)
        {
            var tmp_ebp = this.reg16[reg_ebp];
            for(var i = 1; i < nesting_level; i++)
            {
                tmp_ebp -= 2;
                this.push16(this.safe_read16(this.get_seg(reg_ss) + tmp_ebp | 0));
            }
            this.push16(frame_temp);
        }
        this.reg16[reg_bp] = frame_temp;
        //this.reg16[reg_sp] -= size;
        this.adjust_stack_reg(-size);
    }

    public enter32(size, nesting_level)
    {
        nesting_level &= 31;

        if(nesting_level) dbg_log("enter32 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
        this.push32(this.reg32s[reg_ebp]);
        var frame_temp = this.reg32s[reg_esp];

        if(nesting_level > 0)
        {
            var tmp_ebp = this.reg32s[reg_ebp];
            for(var i = 1; i < nesting_level; i++)
            {
                tmp_ebp -= 4;
                this.push32(this.safe_read32s(this.get_seg(reg_ss) + tmp_ebp | 0));
            }
            this.push32(frame_temp);
        }
        this.reg32s[reg_ebp] = frame_temp;
        //this.reg32s[reg_esp] -= size;
        this.adjust_stack_reg(-size);
    }

    public bswap(reg)
    {
        var temp = this.reg32s[reg];

        this.reg32s[reg] = temp >>> 24 | temp << 24 | (temp >> 8 & 0xFF00) | (temp << 8 & 0xFF0000);
    }

    // former modrm.ts

    /**
     * This file contains functions to decode the modrm and sib bytes
     *
     * These functions return a virtual address
     *
     * @fileoverview .
     * @suppress {newCheckTypes}
     */

    private modrm_table16 = Array(0xC0);
    private modrm_table32 = Array(0xC0);
    private sib_table = Array(0x100);

    private init_modrm()
    {
        this.modrm_table16[0x00 | 0] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 0] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 0] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 1] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 1] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 1] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 2] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 2] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 2] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 3] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 3] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 3] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 4] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 4] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 4] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 5] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 5] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 5] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 6] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 6] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 6] = (cpu) =>
        {
            return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x00 | 7] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) & 0xFFFF) | 0;
        }
        this.modrm_table16[0x40 | 7] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_disp8s() & 0xFFFF) | 0;
        }
        this.modrm_table16[0x80 | 7] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_disp16() & 0xFFFF) | 0;
        }
        this.modrm_table32[0x00 | 0] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) | 0;
        }
        this.modrm_table32[0x40 | 0] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 0] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 1] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) | 0;
        }
        this.modrm_table32[0x40 | 1] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 1] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 2] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) | 0;
        }
        this.modrm_table32[0x40 | 2] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 2] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 3] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) | 0;
        }
        this.modrm_table32[0x40 | 3] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 3] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 5] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) | 0;
        }
        this.modrm_table32[0x40 | 5] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 5] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 6] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) | 0;
        }
        this.modrm_table32[0x40 | 6] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 6] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 7] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) | 0;
        }
        this.modrm_table32[0x40 | 7] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 7] = (cpu) =>
        {
            return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_disp32s() | 0;
        }
        // special cases
        this.modrm_table16[0x00 | 6] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.read_disp16() | 0;
        }
        this.modrm_table32[0x00 | 5] = (cpu) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.read_disp32s() | 0;
        }
        this.modrm_table32[0x00 | 4] = (cpu) =>
        {
            return cpu.sib_resolve(false) | 0;
        }
        this.modrm_table32[0x40 | 4] = (cpu) =>
        {
            return cpu.sib_resolve(true) + cpu.read_disp8s() | 0;
        }
        this.modrm_table32[0x80 | 4] = (cpu) =>
        {
            return cpu.sib_resolve(true) + cpu.read_disp32s() | 0;
        }
        for(var low = 0; low < 8; low++)
        {
            for(var high = 0; high < 3; high++)
            {
                var x = low | high << 6;
                for(var i = 1; i < 8; i++)
                {
                    this.modrm_table32[x | i << 3] = this.modrm_table32[x];
                    this.modrm_table16[x | i << 3] = this.modrm_table16[x];
                }
            }
        }

        this.sib_table[0x00 | 0 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 0 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 0 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 0 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 0 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 1 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 1 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 1 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 1 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 2 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 2 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 2 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 2 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 3 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 3 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 3 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 3 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 0] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 1] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 2] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 3] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 4] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 5] = (cpu, mod) =>
        {
            return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 6] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 4 << 3 | 7] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 0] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 1] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 2] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 3] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 4] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 5] = (cpu, mod) =>
        {
            return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 6] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 4 << 3 | 7] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 0] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 1] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 2] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 3] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 4] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 5] = (cpu, mod) =>
        {
            return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 6] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 4 << 3 | 7] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 0] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 1] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 2] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 3] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 4] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 5] = (cpu, mod) =>
        {
            return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 6] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 4 << 3 | 7] = (cpu, mod) =>
        {
            return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 5 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 5 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 5 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 5 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 6 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 6 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 6 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 6 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x00 | 7 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x40 | 7 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0x80 | 7 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 0] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 1] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 2] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 3] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 4] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 5] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 6] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
        }
        this.sib_table[0xC0 | 7 << 3 | 7] = (cpu, mod) =>
        {
            return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
        }
    }


    // former state.ts

    public save_state()
    {
        var saved_buffers = [];
        var state = State.save_object(this, saved_buffers);

        var buffer_infos = [];
        var total_buffer_size = 0;

        for(var i = 0; i < saved_buffers.length; i++)
        {
            var len = saved_buffers[i].byteLength;

            buffer_infos[i] = {
                offset: total_buffer_size,
                length: len,
            };

            total_buffer_size += len;

            // align
            total_buffer_size = total_buffer_size + 3 & ~3;
        }

        var info_object = JSON.stringify({
            "buffer_infos": buffer_infos,
            "state": state,
        });

        var buffer_block_start = State.STATE_INFO_BLOCK_START + 2 * info_object.length;
        buffer_block_start = buffer_block_start + 3 & ~3;
        var total_size = buffer_block_start + total_buffer_size;

        //console.log("State: json_size=" + Math.ceil(buffer_block_start / 1024 / 1024) + "MB " +
        //               "buffer_size=" + Math.ceil(total_buffer_size / 1024 / 1024) + "MB");

        var result = new ArrayBuffer(total_size);

        var header_block = new Int32Array(
            result,
            0,
            State.STATE_INFO_BLOCK_START / 4
        );
        var info_block = new Uint16Array(
            result,
            State.STATE_INFO_BLOCK_START,
            info_object.length
        );
        var buffer_block = new Uint8Array(
            result,
            buffer_block_start
        );

        header_block[State.STATE_INDEX_MAGIC] = State.STATE_MAGIC;
        header_block[State.STATE_INDEX_VERSION] = State.STATE_VERSION;
        header_block[State.STATE_INDEX_TOTAL_LEN] = total_size;
        header_block[State.STATE_INDEX_INFO_LEN] = info_object.length * 2;

        for(var i = 0; i < info_object.length; i++)
        {
            info_block[i] = info_object.charCodeAt(i);
        }

        for(var i = 0; i < saved_buffers.length; i++)
        {
            var buffer = saved_buffers[i];
            buffer_block.set(new Uint8Array(buffer), buffer_infos[i].offset);
        }

        return result;
    };

    public restore_state(state)
    {
        var len = state.byteLength;

        if(len < State.STATE_INFO_BLOCK_START)
        {
            throw new StateLoadError("Invalid length: " + len);
        }

        var header_block = new Int32Array(state, 0, 4);

        if(header_block[State.STATE_INDEX_MAGIC] !== State.STATE_MAGIC)
        {
            throw new StateLoadError("Invalid header: " + h(header_block[State.STATE_INDEX_MAGIC] >>> 0));
        }

        if(header_block[State.STATE_INDEX_VERSION] !== State.STATE_VERSION)
        {
            throw new StateLoadError(
                    "Version mismatch: dump=" + header_block[State.STATE_INDEX_VERSION] +
                    " we=" + State.STATE_VERSION);
        }

        if(header_block[State.STATE_INDEX_TOTAL_LEN] !== len)
        {
            throw new StateLoadError(
                    "Length doesn't match header: " +
                    "real=" + len + " header=" + header_block[State.STATE_INDEX_TOTAL_LEN]);
        }

        var info_block_len = header_block[State.STATE_INDEX_INFO_LEN];

        if(info_block_len < 0 ||
        info_block_len + 12 >= len ||
        info_block_len % 2)
        {
            throw new StateLoadError("Invalid info block length: " + info_block_len);
        }

        var info_block_str_len = info_block_len / 2;
        var info_block_buffer = new Uint16Array(state, State.STATE_INFO_BLOCK_START, info_block_str_len);
        var info_block = "";

        for(var i = 0; i < info_block_str_len - 8; )
        {
            info_block += String.fromCharCode(
                info_block_buffer[i++], info_block_buffer[i++],
                info_block_buffer[i++], info_block_buffer[i++],
                info_block_buffer[i++], info_block_buffer[i++],
                info_block_buffer[i++], info_block_buffer[i++]
            );
        }

        for(; i < info_block_str_len; )
        {
            info_block += String.fromCharCode(info_block_buffer[i++]);
        }

        var info_block_obj = JSON.parse(info_block);
        var state_object = info_block_obj["state"];
        var buffer_infos = info_block_obj["buffer_infos"];
        var buffer_block_start = State.STATE_INFO_BLOCK_START + info_block_len;
        buffer_block_start = buffer_block_start + 3 & ~3;

        for(var i = 0; i < buffer_infos.length; i++)
        {
            buffer_infos[i].offset += buffer_block_start;
        }

        var buffers = {
            full: state,
            infos: buffer_infos,
        };

        State.restore_object(this, state_object, buffers);
    };

    // string.ts

    public movsb()
    {
        var cpu = this;
        var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
        var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
        var size = cpu.flags & flag_direction ? -1 : 1;

        if(cpu.prefixes & PREFIX_MASK_REP)
        {
            var count = cpu.get_reg_asize(reg_ecx) >>> 0;
            if(count === 0) return;
            var cont = false;
            var start_count = count;
            var cycle_counter = StringX.MAX_COUNT_PER_CYCLE;
            var phys_src = cpu.translate_address_read(src);
            var phys_dest = cpu.translate_address_write(dest);
            if(cpu.paging)
            {
                cycle_counter = StringX.string_get_cycle_count2(size, src, dest);
            }
            do
            {
                cpu.write8(phys_dest, cpu.read8(phys_src));
                phys_dest += size;
                phys_src += size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.add_reg_asize(reg_esi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
            if(cont)
            {
                //cpu.instruction_pointer = cpu.previous_ip;
                this.movsb();
            }
        }
        else
        {
            cpu.safe_write8(dest, cpu.safe_read8(src));
            cpu.add_reg_asize(reg_edi, size);
            cpu.add_reg_asize(reg_esi, size);
        }
        cpu.diverged();
    }

    public movsw()
    {
        var cpu = this;
        var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
        var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
        var size = cpu.flags & flag_direction ? -2 : 2;

        if(cpu.prefixes & PREFIX_MASK_REP)
        {
            var count = cpu.get_reg_asize(reg_ecx) >>> 0;
            if(count === 0) return;
            var cont = false;
            var start_count = count;
            var cycle_counter = StringX.MAX_COUNT_PER_CYCLE;
            if(!(dest & 1) && !(src & 1))
            {
                var single_size = size < 0 ? -1 : 1;
                var phys_src = cpu.translate_address_read(src) >> 1;
                var phys_dest = cpu.translate_address_write(dest) >> 1;
                if(cpu.paging)
                {
                    cycle_counter = StringX.string_get_cycle_count2(size, src, dest);
                }
                do
                {
                    cpu.write_aligned16(phys_dest, cpu.read_aligned16(phys_src));
                    phys_dest += single_size;
                    phys_src += single_size;
                    cont = --count !== 0;
                }
                while(cont && cycle_counter--);
                var diff = size * (start_count - count) | 0;
                cpu.add_reg_asize(reg_edi, diff);
                cpu.add_reg_asize(reg_esi, diff);
                cpu.set_ecx_asize(count);
                cpu.timestamp_counter += start_count - count;
            }
            else
            {
                do
                {
                    cpu.safe_write16(dest, cpu.safe_read16(src));
                    dest += size;
                    cpu.add_reg_asize(reg_edi, size);
                    src += size;
                    cpu.add_reg_asize(reg_esi, size);
                    cont = cpu.decr_ecx_asize() !== 0;
                }
                while(cont && cycle_counter--);
            }
            if(cont)
            {
                //cpu.instruction_pointer = cpu.previous_ip;
                this.movsw();
            }
        }
        else
        {
            cpu.safe_write16(dest, cpu.safe_read16(src));
            cpu.add_reg_asize(reg_edi, size);
            cpu.add_reg_asize(reg_esi, size);
        }
        cpu.diverged();
    }

    public movsd()
    {
        var cpu = this;
        //if(cpu.prefixes & PREFIX_MASK_REP)
        // if(false)
        // {
        //     // often used by memcpy, well worth optimizing
        //     //   using cpu.mem32s.set
        //     var ds = cpu.get_seg_prefix(reg_ds),
        //         src = ds + cpu.get_reg_asize(reg_esi) | 0,
        //         es = cpu.get_seg(reg_es),
        //         dest = es + cpu.get_reg_asize(reg_edi) | 0,
        //         count = cpu.get_reg_asize(reg_ecx) >>> 0;

        //     if(!count)
        //     {
        //         return;
        //     }

        //     // must be page-aligned if cpu.paging is enabled
        //     // and dword-aligned in general
        //     var align_mask = cpu.paging ? 0xFFF : 3;

        //     if((dest & align_mask) === 0 &&
        //     (src & align_mask) === 0 &&
        //     // If df is set, alignment works a different
        //     // This should be unlikely
        //     (cpu.flags & flag_direction) === 0)
        //     {
        //         var cont = false;
        //         if(cpu.paging)
        //         {
        //             src = cpu.translate_address_read(src);
        //             dest = cpu.translate_address_write(dest);

        //             if(count > 0x400)
        //             {
        //                 count = 0x400;
        //                 cont = true;
        //             }
        //         }

        //         if(!cpu.io.in_mmap_range(src, count) &&
        //             !cpu.io.in_mmap_range(dest, count))
        //         {
        //             var diff = count << 2;
        //             cpu.add_reg_asize(reg_ecx, -count);
        //             cpu.add_reg_asize(reg_edi, diff);
        //             cpu.add_reg_asize(reg_esi, diff);

        //             dest >>= 2;
        //             src >>= 2;
        //             cpu.write_blob32(cpu.mem32s.subarray(src, src + count), dest);

        //             if(cont)
        //             {
        //                 //cpu.instruction_pointer = cpu.previous_ip;
        //                 this.movsd();
        //             }

        //             return;
        //         }
        //     }
        // }

        var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
        var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
        var size = cpu.flags & flag_direction ? -4 : 4;

        if(cpu.prefixes & PREFIX_MASK_REP)
        {
            var count = cpu.get_reg_asize(reg_ecx) >>> 0;
            if(count === 0) return;
            var cont = false;
            var start_count = count;
            var cycle_counter = StringX.MAX_COUNT_PER_CYCLE;
            if(!(dest & 3) && !(src & 3))
            {
                var single_size = size < 0 ? -1 : 1;
                var phys_src = cpu.translate_address_read(src) >>> 2;
                var phys_dest = cpu.translate_address_write(dest) >>> 2;
                if(cpu.paging)
                {
                    cycle_counter = StringX.string_get_cycle_count2(size, src, dest);
                }
                do
                {
                    cpu.write_aligned32(phys_dest, cpu.read_aligned32(phys_src));
                    phys_dest += single_size;
                    phys_src += single_size;
                    cont = --count !== 0;
                }
                while(cont && cycle_counter--);
                var diff = size * (start_count - count) | 0;
                cpu.add_reg_asize(reg_edi, diff);
                cpu.add_reg_asize(reg_esi, diff);
                cpu.set_ecx_asize(count);
                cpu.timestamp_counter += start_count - count;
            }
            else
            {
                do
                {
                    cpu.safe_write32(dest, cpu.safe_read32s(src));
                    dest += size;
                    cpu.add_reg_asize(reg_edi, size);
                    src += size;
                    cpu.add_reg_asize(reg_esi, size);
                    cont = cpu.decr_ecx_asize() !== 0;
                }
                while(cont && cycle_counter--);
            }
            if(cont)
            {
                this.instruction_pointer = this.previous_ip;
                //this.movsd();
            }
        }
        else
        {
            cpu.safe_write32(dest, cpu.safe_read32s(src));
            cpu.add_reg_asize(reg_edi, size);
            cpu.add_reg_asize(reg_esi, size);
        }
        cpu.diverged();
    }

    // former arith.ts

    /*
    * Arithmatic functions
    * This file contains:
    *
    * add, adc, sub, sbc, cmp
    * inc, dec
    * neg, not
    * imul, mul, idiv, div
    * xadd
    *
    * das, daa, aad, aam
    *
    * and, or, xor, test
    * shl, shr, sar, ror, rol, rcr, rcl
    * shld, shrd
    *
    * bts, btr, btc, bt
    * bsf, bsr
    *
    * popcnt
    */

    public add8(dest, src) { return this.add(dest, src, OPSIZE_8); }
    public add16(dest, src) { return this.add(dest, src, OPSIZE_16); }
    public add32(dest, src) { return this.add(dest, src, OPSIZE_32); }

    public adc8(dest, src) { return this.adc(dest, src, OPSIZE_8); }
    public adc16(dest, src) { return this.adc(dest, src, OPSIZE_16); }
    public adc32(dest, src) { return this.adc(dest, src, OPSIZE_32); }

    public sub8(dest, src) { return this.sub(dest, src, OPSIZE_8); }
    public sub16(dest, src) { return this.sub(dest, src, OPSIZE_16); }
    public sub32(dest, src) { return this.sub(dest, src, OPSIZE_32); }

    public cmp8(dest, src) { return this.sub(dest, src, OPSIZE_8); }
    public cmp16(dest, src) { return this.sub(dest, src, OPSIZE_16); }
    public cmp32(dest, src) { return this.sub(dest, src, OPSIZE_32); }

    public sbb8(dest, src) { return this.sbb(dest, src, OPSIZE_8); }
    public sbb16(dest, src) { return this.sbb(dest, src, OPSIZE_16); }
    public sbb32(dest, src) { return this.sbb(dest, src, OPSIZE_32); }

    public add(dest_operand, source_operand, op_size)
    {
        //if(this.safe_read32s(this.instruction_pointer + 1) === 0 && this.safe_read32s(this.instruction_pointer + 5) === 0) throw "0000000";

        this.last_op1 = dest_operand;
        this.last_op2 = source_operand;
        this.last_add_result = this.last_result = dest_operand + source_operand | 0;

        this.last_op_size = op_size;
        this.flags_changed = flags_all;

        return this.last_result;
    }

    public adc(dest_operand, source_operand, op_size)
    {
        var cf = this.getcf();
        this.last_op1 = dest_operand;
        this.last_op2 = source_operand;
        this.last_add_result = this.last_result = (dest_operand + source_operand | 0) + cf | 0;

        this.last_op_size = op_size;
        this.flags_changed = flags_all;

        return this.last_result;
    }

    public sub(dest_operand, source_operand, op_size)
    {
        this.last_add_result = dest_operand;
        this.last_op2 = source_operand;
        this.last_op1 = this.last_result = dest_operand - source_operand | 0;

        this.last_op_size = op_size;
        this.flags_changed = flags_all;

        return this.last_result;
    }

    public sbb(dest_operand, source_operand, op_size)
    {
        var cf = this.getcf();
        this.last_add_result = dest_operand;
        this.last_op2 = source_operand;
        this.last_op1 = this.last_result = dest_operand - source_operand - cf | 0;
        this.last_op_size = op_size;

        this.flags_changed = flags_all;

        return this.last_result;
    }

    /*
    * inc and dec
    */

    public inc8(dest) { return this.inc(dest, OPSIZE_8); }
    public inc16(dest) { return this.inc(dest, OPSIZE_16); }
    public inc32(dest) { return this.inc(dest, OPSIZE_32); }

    public dec8(dest) { return this.dec(dest, OPSIZE_8); }
    public dec16(dest) { return this.dec(dest, OPSIZE_16); }
    public dec32(dest) { return this.dec(dest, OPSIZE_32); }

    public inc(dest_operand, op_size)
    {
        this.flags = (this.flags & ~1) | this.getcf();
        this.last_op1 = dest_operand;
        this.last_op2 = 1;
        this.last_add_result = this.last_result = dest_operand + 1 | 0;
        this.last_op_size = op_size;

        this.flags_changed = flags_all & ~1;

        return this.last_result;
    }

    public dec(dest_operand, op_size)
    {
        this.flags = (this.flags & ~1) | this.getcf();
        this.last_add_result = dest_operand;
        this.last_op2 = 1;
        this.last_op1 = this.last_result = dest_operand - 1 | 0;
        this.last_op_size = op_size;

        this.flags_changed = flags_all & ~1;

        return this.last_result;
    }


    /*
    * neg
    */
    public neg8(dest) { return this.neg(dest, OPSIZE_8); }
    public neg16(dest) { return this.neg(dest, OPSIZE_16); }
    public neg32(dest) { return this.neg(dest, OPSIZE_32); }

    public neg(dest_operand, op_size)
    {
        this.last_op1 = this.last_result = -dest_operand | 0;

        this.flags_changed = flags_all;
        this.last_add_result = 0;
        this.last_op2 = dest_operand;
        this.last_op_size = op_size;

        return this.last_result;
    }


    /*
    * mul, imul, div, idiv
    *
    * Note: imul has some extra opcodes
    *       while other functions only allow
    *       ax * modrm
    */

    public mul8(source_operand)
    {
        var result = source_operand * this.reg8[reg_al];

        this.reg16[reg_ax] = result;
        this.last_result = result & 0xFF;
        this.last_op_size = OPSIZE_8;

        if(result < 0x100)
        {
            this.flags = this.flags & ~1 & ~flag_overflow;
        }
        else
        {
            this.flags = this.flags | 1 | flag_overflow;
        }

        this.flags_changed = flags_all & ~1 & ~flag_overflow;
    }

    public imul8(source_operand)
    {
        var result = source_operand * this.reg8s[reg_al];

        this.reg16[reg_ax] = result;
        this.last_result = result & 0xFF;
        this.last_op_size = OPSIZE_8;

        if(result > 0x7F || result < -0x80)
        {
            this.flags = this.flags | 1 | flag_overflow;
        }
        else
        {
            this.flags = this.flags & ~1 & ~flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
    }

    public mul16(source_operand)
    {
        var result = source_operand * this.reg16[reg_ax],
            high_result = result >>> 16;
        //console.log(h(a) + " * " + h(this.reg16[reg_ax]) + " = " + h(result));

        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = high_result;

        this.last_result = result & 0xFFFF;
        this.last_op_size = OPSIZE_16;

        if(high_result === 0)
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        else
        {
            this.flags |= 1 | flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
    }

    /*
    * imul with 1 argument
    * ax = ax * r/m
    */
    public imul16(source_operand)
    {
        var result = source_operand * this.reg16s[reg_ax];

        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = result >> 16;

        this.last_result = result & 0xFFFF;
        this.last_op_size = OPSIZE_16;

        if(result > 0x7FFF || result < -0x8000)
        {
            this.flags |= 1 | flag_overflow;
        }
        else
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
    }

    /*
    * imul with 2 or 3 arguments
    * reg = reg * r/m
    * reg = imm * r/m
    */
    public imul_reg16(operand1, operand2)
    {
        dbg_assert(operand1 < 0x8000 && operand1 >= -0x8000);
        dbg_assert(operand2 < 0x8000 && operand2 >= -0x8000);

        var result = operand1 * operand2;

        this.last_result = result & 0xFFFF;
        this.last_op_size = OPSIZE_16;

        if(result > 0x7FFF || result < -0x8000)
        {
            this.flags |= 1 | flag_overflow;
        }
        else
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        return result;
    }

    public do_mul32(a, b)
    {
        var a00 = a & 0xFFFF;
        var a16 = a >>> 16;
        var b00 = b & 0xFFFF;
        var b16 = b >>> 16;
        var low_result = a00 * b00;
        var mid = (low_result >>> 16) + (a16 * b00 | 0) | 0;
        var high_result = mid >>> 16;
        mid = (mid & 0xFFFF) + (a00 * b16 | 0) | 0;
        this.mul32_result[0] = (mid << 16) | low_result & 0xFFFF;
        this.mul32_result[1] = ((mid >>> 16) + (a16 * b16 | 0) | 0) + high_result | 0;
        return this.mul32_result;
    };

    public do_imul32(a, b)
    {
        var is_neg = false;
        if(a < 0) {
            is_neg = true;
            a = -a | 0;
        }
        if(b < 0) {
            is_neg = !is_neg;
            b = -b | 0;
        }
        var result = this.do_mul32(a, b);
        if(is_neg) {
            result[0] = -result[0] | 0;
            result[1] = ~result[1] + (+!result[0]) | 0;
        }
        return result;
    }

    public mul32(source_operand)
    {
        var dest_operand = this.reg32s[reg_eax];

        var result = this.do_mul32(dest_operand, source_operand);

        this.reg32s[reg_eax] = result[0];
        this.reg32s[reg_edx] = result[1];

        this.last_result = result[0];
        this.last_op_size = OPSIZE_32;

        if(result[1] === 0)
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        else
        {
            this.flags |= 1 | flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        //console.log(h(source_operand >>> 0, 8) + " * " + h(dest_operand >>> 0, 8));
        //console.log("= " + h(this.reg32[reg_edx], 8) + ":" + h(this.reg32[reg_eax], 8));
    }

    public imul32(source_operand)
    {
        dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

        var dest_operand = this.reg32s[reg_eax];

        var result = this.do_imul32(dest_operand, source_operand);

        this.reg32s[reg_eax] = result[0];
        this.reg32s[reg_edx] = result[1];

        this.last_result = result[0];
        this.last_op_size = OPSIZE_32;

        if(result[1] === (result[0] >> 31))
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        else
        {
            this.flags |= 1 | flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        //console.log(target_operand + " * " + source_operand);
        //console.log("= " + h(this.reg32[reg_edx]) + " " + h(this.reg32[reg_eax]));
    }

    /*
    * imul with 2 or 3 arguments
    * reg = reg * r/m
    * reg = imm * r/m
    */
    public imul_reg32(operand1, operand2)
    {
        dbg_assert(operand1 < 0x80000000 && operand1 >= -0x80000000);
        dbg_assert(operand2 < 0x80000000 && operand2 >= -0x80000000);

        var result = this.do_imul32(operand1, operand2);

        this.last_result = result[0];
        this.last_op_size = OPSIZE_32;

        if(result[1] === (result[0] >> 31))
        {
            this.flags &= ~1 & ~flag_overflow;
        }
        else
        {
            this.flags |= 1 | flag_overflow;
        }
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        return result[0];

        //console.log(operand + " * " + source_operand);
        //console.log("= " + this.reg32[reg]);
    }

    public div8(source_operand)
    {
        dbg_assert(source_operand >= 0 && source_operand < 0x100);

        if(source_operand === 0)
        {
            this.trigger_de();
            return;
        }

        var target_operand = this.reg16[reg_ax],
            result = target_operand / source_operand | 0;

        if(result >= 0x100)
        {
            this.trigger_de();
        }
        else
        {
            this.reg8[reg_al] = result;
            this.reg8[reg_ah] = target_operand % source_operand;
        }
    }

    public idiv8(source_operand)
    {
        dbg_assert(source_operand >= -0x80 && source_operand < 0x80);

        if(source_operand === 0)
        {
            this.trigger_de();
            return;
        }

        var target_operand = this.reg16s[reg_ax],
            result = target_operand / source_operand | 0;

        if(result >= 0x80 || result <= -0x81)
        {
            this.trigger_de();
        }
        else
        {
            this.reg8[reg_al] = result;
            this.reg8[reg_ah] = target_operand % source_operand;
        }
    }

    public div16(source_operand)
    {
        dbg_assert(source_operand >= 0 && source_operand < 0x10000);

        if(source_operand === 0)
        {
            this.trigger_de();
            return;
        }

        var
            target_operand = (this.reg16[reg_ax] | this.reg16[reg_dx] << 16) >>> 0,
            result = target_operand / source_operand | 0;

        if(result >= 0x10000 || result < 0)
        {
            this.trigger_de();
        }
        else
        {
            this.reg16[reg_ax] = result;
            this.reg16[reg_dx] = target_operand % source_operand;
        }
    }

    public idiv16(source_operand)
    {
        dbg_assert(source_operand >= -0x8000 && source_operand < 0x8000);

        if(source_operand === 0)
        {
            this.trigger_de();
            return;
        }

        var target_operand = this.reg16[reg_ax] | (this.reg16[reg_dx] << 16),
            result = target_operand / source_operand | 0;

        if(result >= 0x8000 || result <= -0x8001)
        {
            this.trigger_de();
        }
        else
        {
            this.reg16[reg_ax] = result;
            this.reg16[reg_dx] = target_operand % source_operand;
        }
    }

    // If the dividend is too large, the division cannot be done precisely using
    // JavaScript's double floating point numbers. Run simple long divsion until
    // the dividend is small enough
    public do_div32(div_low, div_high, quot)
    {
        if(div_high >= quot || quot === 0)
        {
            dbg_log("div32 #DE: " + h(div_high, 8) + ":" + h(div_low, 8) + " div " + h(quot, 8));
            this.trigger_de();
        }

        var result = 0;

        if(div_high > 0x100000)
        {
            var m = 0;
            var i = 32;
            var q = quot;
            while(q > div_high)
            {
                q >>>= 1;
                i--;
            }
            while(div_high > 0x100000)
            {
                if(div_high >= q)
                {
                    div_high -= q;
                    var sub = quot << i >>> 0;
                    if(sub > div_low)
                    {
                        div_high--;
                    }
                    div_low = div_low - sub >>> 0;
                    result |= 1 << i
                }
                i--;
                q >>= 1;
            }
            result >>>= 0;
        }

        var div = div_low + div_high * 0x100000000;
        var mod = div % quot;
        result += div / quot | 0;

        this.div32_result[0] = result;
        this.div32_result[1] = mod;
        return this.div32_result;
    }


    public div32(source_operand)
    {
        dbg_assert(source_operand >= 0 && source_operand <= 0xffffffff);

        var dest_operand_low = this.reg32[reg_eax],
            dest_operand_high = this.reg32[reg_edx];

        var result_mod = this.do_div32(dest_operand_low, dest_operand_high, source_operand);
        var result = result_mod[0];
        var mod = result_mod[1];

        // XXX
        dbg_assert(source_operand);
        if(result >= 0x100000000)
        {
            dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
            dbg_log("-> " + h(result));

            this.trigger_de();
        }
        else
        {
            this.reg32s[reg_eax] = result;
            this.reg32s[reg_edx] = mod;
        }

        //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
        //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
    }

    public idiv32(source_operand)
    {
        dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

        var dest_operand_low = this.reg32[reg_eax],
            dest_operand_high = this.reg32s[reg_edx],
            div_is_neg = false,
            is_neg = false;

        if(source_operand < 0)
        {
            is_neg = true;
            source_operand = -source_operand;
        }

        if(dest_operand_high < 0)
        {
            div_is_neg = true;
            is_neg = !is_neg;
            dest_operand_low = -dest_operand_low >>> 0;
            dest_operand_high = ~dest_operand_high + (+!dest_operand_low);
        }

        var result_mod = this.do_div32(dest_operand_low, dest_operand_high, source_operand);
        var result = result_mod[0];
        var mod = result_mod[1];

        if(is_neg)
        {
            result = -result | 0;
        }

        if(div_is_neg)
        {
            mod = -mod | 0;
        }

        dbg_assert(source_operand);
        if(result >= 0x80000000 || result <= -0x80000001)
        {
            dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
            dbg_log("-> " + h(result));
            this.trigger_de();
        }
        else
        {
            this.reg32s[reg_eax] = result;
            this.reg32s[reg_edx] = mod;
        }

        //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
        //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
    }


    public xadd8(source_operand, reg)
    {
        var tmp = this.reg8[reg];

        this.reg8[reg] = source_operand;

        return this.add(source_operand, tmp, OPSIZE_8);
    }


    public xadd16(source_operand, reg)
    {
        var tmp = this.reg16[reg];

        this.reg16[reg] = source_operand;

        return this.add(source_operand, tmp, OPSIZE_16);
    }


    public xadd32(source_operand, reg)
    {
        var tmp = this.reg32s[reg];

        this.reg32s[reg] = source_operand;

        return this.add(source_operand, tmp, OPSIZE_32);
    }


    public bcd_daa()
    {
        //dbg_log("daa");
        // decimal adjust after addition
        var old_al = this.reg8[reg_al],
            old_cf = this.getcf(),
            old_af = this.getaf();

        this.flags &= ~1 & ~flag_adjust

        if((old_al & 0xF) > 9 || old_af)
        {
            this.reg8[reg_al] += 6;
            this.flags |= flag_adjust;
        }
        if(old_al > 0x99 || old_cf)
        {
            this.reg8[reg_al] += 0x60;
            this.flags |= 1;
        }

        this.last_result = this.reg8[reg_al];
        this.last_op_size = OPSIZE_8;
        this.last_op1 = this.last_op2 = 0;
        this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
    }

    public bcd_das()
    {
        //dbg_log("das");
        // decimal adjust after subtraction
        var old_al = this.reg8[reg_al],
            old_cf = this.getcf();

        this.flags &= ~1;

        if((old_al & 0xF) > 9 || this.getaf())
        {
            this.reg8[reg_al] -= 6;
            this.flags |= flag_adjust;
            this.flags = this.flags & ~1 | old_cf | this.reg8[reg_al] >> 7;
        }
        else
        {
            this.flags &= ~flag_adjust;
        }

        if(old_al > 0x99 || old_cf)
        {
            this.reg8[reg_al] -= 0x60;
            this.flags |= 1;
        }

        this.last_result = this.reg8[reg_al];
        this.last_op_size = OPSIZE_8;
        this.last_op1 = this.last_op2 = 0;
        this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
    }

    public bcd_aam(imm8)
    {
        //dbg_log("aam");
        // ascii adjust after multiplication

        if(imm8 === 0)
        {
            this.trigger_de();
        }
        else
        {
            var temp = this.reg8[reg_al];
            this.reg8[reg_ah] = temp / imm8;
            this.reg8[reg_al] = temp % imm8;

            this.last_result = this.reg8[reg_al];

            this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
            this.flags &= ~1 & ~flag_adjust & ~flag_overflow;
        }
    }

    public bcd_aad(imm8)
    {
        //dbg_log("aad");
        // ascii adjust before division

        var result = this.reg8[reg_al] + this.reg8[reg_ah] * imm8;
        this.last_result = result & 0xFF;
        this.reg16[reg_ax] = this.last_result;
        this.last_op_size = OPSIZE_8;

        this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
        this.flags &= ~1 & ~flag_adjust & ~flag_overflow;

        if(result > 0xFFFF)
        {
            this.flags |= 1;
        }
    }

    public bcd_aaa()
    {
        //dbg_log("aaa");
        if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
        {
            this.reg16[reg_ax] += 6;
            this.reg8[reg_ah] += 1;
            this.flags |= flag_adjust | 1;
        }
        else
        {
            this.flags &= ~flag_adjust & ~1;
        }
        this.reg8[reg_al] &= 0xF;

        this.flags_changed &= ~flag_adjust & ~1;
    };


    public bcd_aas()
    {
        //dbg_log("aas");
        if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
        {
            this.reg16[reg_ax] -= 6;
            this.reg8[reg_ah] -= 1;
            this.flags |= flag_adjust | 1;
        }
        else
        {
            this.flags &= ~flag_adjust & ~1;
        }
        this.reg8[reg_al] &= 0xF;

        this.flags_changed &= ~flag_adjust & ~1;
    }


    /*                     \O
    * bitwise functions    |\
    *                     / \
    *
    * and, or, xor, test
    * shl, shr, sar, rol, ror, rcl, ror
    * shrd, shld
    *
    * bt, bts, btr, btc
    * bsf, bsr
    */

    public and8(dest, src) { return this.and(dest, src, OPSIZE_8); }
    public and16(dest, src) { return this.and(dest, src, OPSIZE_16); }
    public and32(dest, src) { return this.and(dest, src, OPSIZE_32); }

    public test8(dest, src) { return this.and(dest, src, OPSIZE_8); }
    public test16(dest, src) { return this.and(dest, src, OPSIZE_16); }
    public test32(dest, src) { return this.and(dest, src, OPSIZE_32); }

    public or8(dest, src) { return this.or(dest, src, OPSIZE_8); }
    public or16(dest, src) { return this.or(dest, src, OPSIZE_16); }
    public or32(dest, src) { return this.or(dest, src, OPSIZE_32); }

    public xor8(dest, src) { return this.xor(dest, src, OPSIZE_8); }
    public xor16(dest, src) { return this.xor(dest, src, OPSIZE_16); }
    public xor32(dest, src) { return this.xor(dest, src, OPSIZE_32); }

    public and(dest_operand, source_operand, op_size)
    {
        this.last_result = dest_operand & source_operand;

        this.last_op_size = op_size;
        this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
        this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

        return this.last_result;
    }

    public or(dest_operand, source_operand, op_size)
    {
        this.last_result = dest_operand | source_operand;

        this.last_op_size = op_size;
        this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
        this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

        return this.last_result;
    }

    public xor(dest_operand, source_operand, op_size)
    {
        this.last_result = dest_operand ^ source_operand;

        this.last_op_size = op_size;
        this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
        this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

        return this.last_result;
    }


    /*
    * rotates and shifts
    */

    public rol8(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }
        count &= 7;

        var result = dest_operand << count | dest_operand >> (8 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result & 1)
                    | (result << 11 ^ result << 4) & flag_overflow;

        return result;
    }

    public rol16(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }
        count &= 15;

        var result = dest_operand << count | dest_operand >> (16 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result & 1)
                    | (result << 11 ^ result >> 4) & flag_overflow;

        return result;
    }

    public rol32(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand << count | dest_operand >>> (32 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result & 1)
                    | (result << 11 ^ result >> 20) & flag_overflow;

        return result;
    }

    public rcl8(dest_operand, count)
    {
        count %= 9;
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (9 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 8 & 1)
                    | (result << 3 ^ result << 4) & flag_overflow;

        return result;
    }

    public rcl16(dest_operand, count)
    {
        count %= 17;
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (17 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 16 & 1)
                    | (result >> 5 ^ result >> 4) & flag_overflow;

        return result;
    }

    public rcl32(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand << count | this.getcf() << (count - 1);

        if(count > 1)
        {
            result |= dest_operand >>> (33 - count);
        }

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
        this.flags |= (this.flags << 11 ^ result >> 20) & flag_overflow;

        return result;
    }

    public ror8(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        count &= 7;
        var result = dest_operand >> count | dest_operand << (8 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 7 & 1)
                    | (result << 4 ^ result << 5) & flag_overflow;

        return result;
    }

    public ror16(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        count &= 15;
        var result = dest_operand >> count | dest_operand << (16 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 15 & 1)
                    | (result >> 4 ^ result >> 3) & flag_overflow;

        return result;
    }

    public ror32(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand >>> count | dest_operand << (32 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 31 & 1)
                    | (result >> 20 ^ result >> 19) & flag_overflow;

        return result;
    }

    public rcr8(dest_operand, count)
    {
        count %= 9;
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand >> count | this.getcf() << (8 - count) | dest_operand << (9 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 8 & 1)
                    | (result << 4 ^ result << 5) & flag_overflow;

        return result;
    }

    public rcr16(dest_operand, count)
    {
        count %= 17;
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand >> count | this.getcf() << (16 - count) | dest_operand << (17 - count);

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (result >> 16 & 1)
                    | (result >> 4 ^ result >> 3) & flag_overflow;

        return result;
    }

    public rcr32(dest_operand, count)
    {
        if(!count)
        {
            return dest_operand;
        }

        var result = dest_operand >>> count | this.getcf() << (32 - count);

        if(count > 1)
        {
            result |= dest_operand << (33 - count);
        }

        this.flags_changed &= ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (dest_operand >> (count - 1) & 1)
                    | (result >> 20 ^ result >> 19) & flag_overflow;

        return result;
    }

    public shl8(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand << count;

        this.last_op_size = OPSIZE_8;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (this.last_result >> 8 & 1)
                    | (this.last_result << 3 ^ this.last_result << 4) & flag_overflow;

        return this.last_result;
    }

    public shl16(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand << count;

        this.last_op_size = OPSIZE_16;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (this.last_result >> 16 & 1)
                    | (this.last_result >> 5 ^ this.last_result >> 4) & flag_overflow;

        return this.last_result;
    }

    public shl32(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand << count;

        this.last_op_size = OPSIZE_32;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        // test this
        this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
        this.flags |= ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11 & flag_overflow;

        return this.last_result;
    }

    public shr8(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand >> count;

        this.last_op_size = OPSIZE_8;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (dest_operand >> (count - 1) & 1)
                    | (dest_operand >> 7 & 1) << 11 & flag_overflow;

        return this.last_result;
    }

    public shr16(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand >> count;

        this.last_op_size = OPSIZE_16;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (dest_operand >> (count - 1) & 1)
                    | (dest_operand >> 4)  & flag_overflow;

        return this.last_result;
    }

    public shr32(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand >>> count;

        this.last_op_size = OPSIZE_32;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow)
                    | (dest_operand >>> (count - 1) & 1)
                    | (dest_operand >> 20) & flag_overflow;

        return this.last_result;
    }

    public sar8(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        if(count < 8)
        {
            this.last_result = dest_operand << 24 >> count + 24;
            // of is zero
            this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
        }
        else
        {
            this.last_result = dest_operand << 24 >> 31;
            this.flags = (this.flags & ~1 & ~flag_overflow) | (this.last_result & 1);
        }

        this.last_op_size = OPSIZE_8;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        return this.last_result;
    }

    public sar16(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        if(count < 16)
        {
            this.last_result = dest_operand << 16 >> count + 16;
            this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
        }
        else
        {
            this.last_result = dest_operand << 16 >> 31;
            this.flags = (this.flags & ~1 & ~flag_overflow) | (this.last_result & 1);
        }

        this.last_op_size = OPSIZE_16;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;

        return this.last_result;
    }

    public sar32(dest_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand >> count;

        this.last_op_size = OPSIZE_32;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (count - 1) & 1);

        return this.last_result;
    }


    public shrd16(dest_operand, source_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        if(count <= 16)
        {
            this.last_result = dest_operand >> count | source_operand << (16 - count);
            this.flags = (this.flags & ~1) | (dest_operand >> (count - 1) & 1);
        }
        else
        {
            this.last_result = dest_operand << (32 - count) | source_operand >> (count - 16);
            this.flags = (this.flags & ~1) | (source_operand >> (count - 17) & 1);
        }

        this.last_op_size = OPSIZE_16;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 4 & flag_overflow);

        return this.last_result;
    }

    public shrd32(dest_operand, source_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand >>> count | source_operand << (32 - count);

        this.last_op_size = OPSIZE_32;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1) | (dest_operand >>> (count - 1) & 1);
        this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 20 & flag_overflow);

        return this.last_result;
    }

    public shld16(dest_operand, source_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        if(count <= 16)
        {
            this.last_result = dest_operand << count | source_operand >>> (16 - count);
            this.flags = (this.flags & ~1) | (dest_operand >>> (16 - count) & 1);
        }
        else
        {
            this.last_result = dest_operand >> (32 - count) | source_operand << (count - 16);
            this.flags = (this.flags & ~1) | (source_operand >>> (32 - count) & 1);
        }

        this.last_op_size = OPSIZE_16;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 15 & 1)) << 11;

        return this.last_result;
    }

    public shld32(dest_operand, source_operand, count)
    {
        if(count === 0)
        {
            return dest_operand;
        }

        this.last_result = dest_operand << count | source_operand >>> (32 - count);

        this.last_op_size = OPSIZE_32;
        this.flags_changed = flags_all & ~1 & ~flag_overflow;
        this.flags = (this.flags & ~1) | (dest_operand >>> (32 - count) & 1);
        this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11;

        return this.last_result;
    }


    public bt_reg(bit_base, bit_offset)
    {
        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;
    }

    public btc_reg(bit_base, bit_offset)
    {
        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        return bit_base ^ 1 << bit_offset;
    }

    public bts_reg(bit_base, bit_offset)
    {
        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        return bit_base | 1 << bit_offset;
    }

    public btr_reg(bit_base, bit_offset)
    {
        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        return bit_base & ~(1 << bit_offset);
    }

    public bt_mem(virt_addr, bit_offset)
    {
        var bit_base = this.safe_read8(virt_addr + (bit_offset >> 3) | 0);
        bit_offset &= 7;

        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;
    }

    public btc_mem(virt_addr, bit_offset)
    {
        var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3) | 0);
        var bit_base = this.read8(phys_addr);

        bit_offset &= 7;

        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        this.write8(phys_addr, bit_base ^ 1 << bit_offset);
    }

    public btr_mem(virt_addr, bit_offset)
    {
        var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3) | 0);
        var bit_base = this.read8(phys_addr);

        bit_offset &= 7;

        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        this.write8(phys_addr, bit_base & ~(1 << bit_offset));
    }

    public bts_mem(virt_addr, bit_offset)
    {
        var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3) | 0);
        var bit_base = this.read8(phys_addr);

        bit_offset &= 7;

        this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
        this.flags_changed &= ~1;

        this.write8(phys_addr, bit_base | 1 << bit_offset);
    }

    public bsf16(old, bit_base)
    {
        this.flags_changed = flags_all & ~flag_zero;
        this.last_op_size = OPSIZE_16;

        if(bit_base === 0)
        {
            this.flags |= flag_zero;

            // not defined in the docs, but value doesn't change on my intel machine
            return old;
        }
        else
        {
            this.flags &= ~flag_zero;

            // http://jsperf.com/lowest-bit-index
            return this.last_result = v86util.int_log2(-bit_base & bit_base);
        }
    }

    public bsf32(old, bit_base)
    {
        this.flags_changed = flags_all & ~flag_zero;
        this.last_op_size = OPSIZE_32;

        if(bit_base === 0)
        {
            this.flags |= flag_zero;

            return old;
        }
        else
        {
            this.flags &= ~flag_zero;

            return this.last_result = v86util.int_log2((-bit_base & bit_base) >>> 0);
        }
    }

    public bsr16(old, bit_base)
    {
        this.flags_changed = flags_all & ~flag_zero;
        this.last_op_size = OPSIZE_16;

        if(bit_base === 0)
        {
            this.flags |= flag_zero;
            return old;
        }
        else
        {
            this.flags &= ~flag_zero;

            return this.last_result = v86util.int_log2(bit_base);
        }
    }

    public bsr32(old, bit_base)
    {
        this.flags_changed = flags_all & ~flag_zero;
        this.last_op_size = OPSIZE_32;

        if(bit_base === 0)
        {
            this.flags |= flag_zero;
            return old;
        }
        else
        {
            this.flags &= ~flag_zero;
            return this.last_result = v86util.int_log2(bit_base >>> 0);
        }
    }

    public popcnt(v)
    {
        this.flags_changed = 0;
        this.flags &= ~flags_all;

        if(v)
        {
            // http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
            v = v - ((v >> 1) & 0x55555555);
            v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
            return ((v + (v >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
        }
        else
        {
            this.flags |= flag_zero;
            return 0;
        }
    }

    // former debug.ts
    public debug_init()
    {
        this.debug = new Debug(this);
    }
}

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["CPU"] = CPU;
}
else if(typeof importScripts === "function")
{
    self["CPU"] = CPU;
}

/** @const */
var LOG_CACHED_VERBOSE = false;

/** @const */
var CACHED_STATS = DEBUG && true;

var stats = {
    clears_write: 0,
    clears_size: 0,
    reusable_instruction: 0,
    cycle_cached: 0,
    cycle_recording: 0,
    created_instruction: 0,
};

import { dbg_log, dbg_assert } from "./log";

/*
 * string operations
 *
 *       cmp  si  di
 * movs   0    1   1/w    A4
 * cmps   1    1   1/r    A6
 * stos   0    0   1/w    AA
 * lods   0    1   0      AC
 * scas   1    0   1/r    AE
 * ins    0    0   1/w
 * outs   0    1   0
 */

/** @const */
export var MAX_COUNT_PER_CYCLE = 0x1000;


export function string_get_cycle_count(size, address)
{
    dbg_assert(size && size <= 4 && size >= -4);

    if(size < 0)
    {
        return (address & 0xFFF) >> (-size >> 1);
    }
    else
    {
        return (~address & 0xFFF) >> size;
    }
}

export function string_get_cycle_count2(size, addr1, addr2)
{
    dbg_assert(arguments.length === 3);

    return Math.min(
            string_get_cycle_count(size, addr1),
            string_get_cycle_count(size, addr2));
}

export function cmpsb(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        var phys_dest = cpu.translate_address_read(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            data_dest = cpu.read8(phys_dest);
            data_src = cpu.read8(phys_src);
            phys_dest += size;
            phys_src += size;
            cont = --count !== 0 && (data_src === data_dest) === is_repz;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_edi, diff);
        cpu.add_reg_asize(reg_esi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_src = cpu.safe_read8(src);
        data_dest = cpu.safe_read8(dest);
        cpu.add_reg_asize(reg_edi, size);
        cpu.add_reg_asize(reg_esi, size);
    }

    cpu.cmp8(data_src, data_dest);
    cpu.diverged();
}

export function cmpsw(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1) && !(src & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >> 1;
            var phys_dest = cpu.translate_address_read(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                data_dest = cpu.read_aligned16(phys_dest);
                data_src = cpu.read_aligned16(phys_src);
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
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
                data_dest = cpu.safe_read16(dest);
                data_src = cpu.safe_read16(src);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                src += size;
                cpu.add_reg_asize(reg_esi, size);
                cont = cpu.decr_ecx_asize() !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read16(dest);
        data_src = cpu.safe_read16(src);
        cpu.add_reg_asize(reg_edi, size);
        cpu.add_reg_asize(reg_esi, size);
    }

    cpu.cmp16(data_src, data_dest);
    cpu.diverged();
}

export function cmpsd(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3) && !(src & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >>> 2;
            var phys_dest = cpu.translate_address_read(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                data_dest = cpu.read_aligned32(phys_dest);
                data_src = cpu.read_aligned32(phys_src);
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
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
                data_dest = cpu.safe_read32s(dest);
                data_src = cpu.safe_read32s(src);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                src += size;
                cpu.add_reg_asize(reg_esi, size);
                cont = cpu.decr_ecx_asize() !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read32s(dest);
        data_src = cpu.safe_read32s(src);
        cpu.add_reg_asize(reg_edi, size);
        cpu.add_reg_asize(reg_esi, size);
    }

    cpu.cmp32(data_src, data_dest);
    cpu.diverged();
}

export function stosb(cpu)
{
    var data = cpu.reg8[reg_al];
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_write(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            cpu.write8(phys_dest, data);
            phys_dest += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_edi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write8(dest, data);
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function stosw(cpu)
{
    var data = cpu.reg16[reg_ax];
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned16(phys_dest, data);
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write16(dest, data);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write16(dest, data);
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function stosd(cpu)
{
    var data = cpu.reg32s[reg_eax];
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned32(phys_dest, data);
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write32(dest, data);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write32(dest, data);
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function lodsb(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            cpu.reg8[reg_al] = cpu.read8(phys_src);
            phys_src += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_esi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg8[reg_al] = cpu.safe_read8(src);
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

export function lodsw(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        do
        {
            cpu.reg16[reg_ax] = cpu.safe_read16(src);
            src += size;
            cpu.add_reg_asize(reg_esi, size);
            cont = cpu.decr_ecx_asize() !== 0;
        }
        while(cont && cycle_counter--);
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg16[reg_ax] = cpu.safe_read16(src);
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

export function lodsd(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        do
        {
            cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
            src += size;
            cpu.add_reg_asize(reg_esi, size);
            cont = cpu.decr_ecx_asize() !== 0;
        }
        while(cont && cycle_counter--);
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

export function scasb(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;
    var data_dest;
    var data_src = cpu.reg8[reg_al];

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_read(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            data_dest = cpu.read8(phys_dest);
            phys_dest += size;
            cont = --count !== 0 && (data_src === data_dest) === is_repz;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_edi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read8(dest);
        cpu.add_reg_asize(reg_edi, size);
    }

    cpu.cmp8(data_src, data_dest);
    cpu.diverged();
}

export function scasw(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;
    var data_dest;
    var data_src = cpu.reg16[reg_al];

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_read(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                data_dest = cpu.read_aligned16(phys_dest);
                phys_dest += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read16(dest);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read16(dest);
        cpu.add_reg_asize(reg_edi, size);
    }

    cpu.cmp16(data_src, data_dest);
    cpu.diverged();
}

export function scasd(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;
    var data_dest;
    var data_src = cpu.reg32s[reg_eax];

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = (cpu.prefixes & PREFIX_MASK_REP) === PREFIX_REPZ;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_read(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                data_dest = cpu.read_aligned32(phys_dest);
                phys_dest += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read32s(dest);
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read32s(dest);
        cpu.add_reg_asize(reg_edi, size);
    }

    cpu.cmp32(data_src, data_dest);
    cpu.diverged();
}

export function insb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_write(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            cpu.write8(phys_dest, cpu.io.port_read8(port));
            phys_dest += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_edi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insb(cpu);
        }
    }
    else
    {
        cpu.safe_write8(dest, cpu.io.port_read8(port));
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function insw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned16(phys_dest, cpu.io.port_read16(port));
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write16(dest, cpu.io.port_read16(port));
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insw(cpu);
        }
    }
    else
    {
        cpu.safe_write16(dest, cpu.io.port_read16(port));
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function insd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    var dest = cpu.get_seg(reg_es) + cpu.get_reg_asize(reg_edi) | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned32(phys_dest, cpu.io.port_read32(port));
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_edi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write32(dest, cpu.io.port_read32(port));
                dest += size;
                cpu.add_reg_asize(reg_edi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insd(cpu);
        }
    }
    else
    {
        cpu.safe_write32(dest, cpu.io.port_read32(port));
        cpu.add_reg_asize(reg_edi, size);
    }
    cpu.diverged();
}

export function outsb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            cpu.io.port_write8(port, cpu.read8(phys_src));
            phys_src += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.add_reg_asize(reg_esi, diff);
        cpu.set_ecx_asize(count);
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsb(cpu);
        }
    }
    else
    {
        cpu.io.port_write8(port, cpu.safe_read8(src));
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

export function outsw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(src & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, src);
            }
            do
            {
                cpu.io.port_write16(port, cpu.read_aligned16(phys_src));
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_esi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.io.port_write16(port, cpu.safe_read16(src));
                src += size;
                cpu.add_reg_asize(reg_esi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsw(cpu);
        }
    }
    else
    {
        cpu.io.port_write16(port, cpu.safe_read16(src));
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

export function outsd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.get_reg_asize(reg_esi) | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.prefixes & PREFIX_MASK_REP)
    {
        var count = cpu.get_reg_asize(reg_ecx) >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(src & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, src);
            }
            do
            {
                cpu.io.port_write32(port, cpu.read_aligned32(phys_src));
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.add_reg_asize(reg_esi, diff);
            cpu.set_ecx_asize(count);
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.io.port_write32(port, cpu.safe_read32s(src));
                src += size;
                cpu.add_reg_asize(reg_esi, size);
                cont = cpu.decr_ecx_asize() !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsd(cpu);
        }
    }
    else
    {
        cpu.io.port_write32(port, cpu.safe_read32s(src));
        cpu.add_reg_asize(reg_esi, size);
    }
    cpu.diverged();
}

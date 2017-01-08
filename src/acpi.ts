import { CPU } from "./cpu";
import { v86 } from "./main";
import { dbg_log, dbg_assert } from "./log";

/** @const */
var PMTIMER_FREQ = 3579545;

export class ACPI
{
    constructor(cpu: CPU)
    {
        var io = cpu.io;

        var acpi = {
            pci_id: 0x07 << 3,
            pci_space: [
                0x86, 0x80, 0x13, 0x71, 0x07, 0x00, 0x80, 0x02, 0x08, 0x00, 0x80, 0x06, 0x00, 0x00, 0x80, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00,
            ],
            pci_bars: [],
            name: "acpi",
        };

        // 00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)
        cpu.devices.pci.register_device(acpi);

        // ACPI status
        io.register_read(0xB004, this, undefined, () =>
        {
            dbg_log("ACPI status read", LOG_ACPI);
            return 1;
        });

        // ACPI, pmtimer
        io.register_read(0xB008, this, undefined, undefined, () =>
        {
            var value = v86.microtick() * (PMTIMER_FREQ / 1000) | 0;
            //dbg_log("pmtimer read: " + h(value >>> 0), LOG_ACPI);
            return value;
        });
    }

}
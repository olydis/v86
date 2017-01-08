import { h, ByteQueue } from "./lib";
import { BusConnector } from "./bus";
import { CPU } from "./cpu";
import { dbg_log, dbg_assert } from "./log";


/*
 * Serial ports
 * http://wiki.osdev.org/UART
 * https://github.com/s-macke/jor1k/blob/master/js/worker/dev/uart.js
 * https://www.freebsd.org/doc/en/articles/serial-uart/
 */

/** @const */
var DLAB = 0x80;


/** @const */ var UART_IER_MSI  = 0x08; /* Modem Status Changed int. */
/** @const */ var UART_IER_THRI = 0x02; /* Enable Transmitter holding register int. */
/** @const */ var UART_IER_RDI = 0x01; /* Enable receiver data interrupt */

/** @const */var UART_IIR_MSI = 0x00; /* Modem status interrupt (Low priority) */
/** @const */var UART_IIR_NO_INT = 0x01;
/** @const */var UART_IIR_THRI = 0x02; /* Transmitter holding register empty */
/** @const */var UART_IIR_RDI = 0x04; /* Receiver data interrupt */
/** @const */var UART_IIR_RLSI = 0x06; /* Receiver line status interrupt (High p.) */
/** @const */var UART_IIR_CTI = 0x0c; /* Character timeout */

/** @const */ var UART_LSR_DATA_READY        = 0x1;  // data available
/** @const */ var UART_LSR_TX_EMPTY        = 0x20; // TX (THR) buffer is empty
/** @const */ var UART_LSR_TRANSMITTER_EMPTY = 0x40; // TX empty and line is idle

export class UART
{
    private ints = 0;

    private baud_rate = 0;

    private line_control = 0;

    // line status register
    private lsr = UART_LSR_TRANSMITTER_EMPTY | UART_LSR_TX_EMPTY;

    private fifo_control = 0;

    // interrupts enable
    private ier = 0;

    // interrupt identification register
    private iir = UART_IIR_NO_INT;

    private modem_control = 0;
    private modem_status = 0;

    private scratch_register = 0;

    private irq = 0;

    private input = new ByteQueue(4096);

    private current_line = [];

        
    constructor(private readonly cpu: CPU, port: number, private readonly bus: BusConnector)
    {
        if(port === 0x3E8 || port === 0x3F8)
        {
            this.irq = 4;
        }
        else if(port === 0x3E8 || port === 0x3E8)
        {
            this.irq = 3;
        }
        else
        {
            dbg_log("Invalid port: " + h(port), LOG_SERIAL);
            return;
        }

        this.bus.register("serial0-input", (data) =>
        {
            this.data_received(data);
        }, this);

        var io = cpu.io;

        var write_data = (out_byte) =>
        {
            if(this.line_control & DLAB)
            {
                this.baud_rate = this.baud_rate & ~0xFF | out_byte;
                return;
            }

            dbg_log("data: " + h(out_byte), LOG_SERIAL);

            this.ThrowInterrupt(UART_IIR_THRI);

            if(out_byte === 0xFF)
            {
                return;
            }

            var char = String.fromCharCode(out_byte);

            this.bus.send("serial0-output-char", char);

            this.current_line.push(out_byte);

            if(char === "\n")
            {
                dbg_log("SERIAL: " + String.fromCharCode.apply("", this.current_line).trimRight());
                this.bus.send("serial0-output-line", String.fromCharCode.apply("", this.current_line));
                this.current_line = [];
            }
        }

        io.register_write(port, this, (out_byte) =>
        {
            write_data.call(this, out_byte);
        }, (out_word) =>
        {
            write_data.call(this, out_word & 0xFF);
            write_data.call(this, out_word >> 8);
        });

        io.register_write(port | 1, this, (out_byte) =>
        {
            if(this.line_control & DLAB)
            {
                this.baud_rate = this.baud_rate & 0xFF | out_byte << 8;
                dbg_log("baud rate: " + h(this.baud_rate), LOG_SERIAL);
            }
            else
            {
                this.ier = out_byte & 0xF;
                dbg_log("interrupt enable: " + h(out_byte), LOG_SERIAL);
                this.CheckInterrupt();
            }
        });

        io.register_read(port, this, () =>
        {
            if(this.line_control & DLAB)
            {
                return this.baud_rate & 0xFF;
            }
            else
            {
                var data = this.input.shift();

                if(data === -1)
                {
                    dbg_log("Read input empty", LOG_SERIAL);
                }
                else
                {
                    dbg_log("Read input: " + h(data), LOG_SERIAL);
                }

                if(this.input.length === 0)
                {
                    this.lsr &= ~UART_LSR_DATA_READY;
                    this.ClearInterrupt(UART_IIR_CTI);
                }

                return data;
            }
        });

        io.register_read(port | 1, this, () =>
        {
            if(this.line_control & DLAB)
            {
                return this.baud_rate >> 8;
            }
            else
            {
                return this.ier & 0xF;
            }
        });

        io.register_read(port | 2, this, () =>
        {
            var ret = this.iir & 0xF | 0xC0;
            dbg_log("read interrupt identification: " + h(this.iir), LOG_SERIAL);

            if (this.iir == UART_IIR_THRI) {
                this.ClearInterrupt(UART_IIR_THRI);
            }

            return ret;
        });
        io.register_write(port | 2, this, (out_byte) =>
        {
            dbg_log("fifo control: " + h(out_byte), LOG_SERIAL);
            this.fifo_control = out_byte;
        });

        io.register_read(port | 3, this, () =>
        {
            dbg_log("read line control: " + h(this.line_control), LOG_SERIAL);
            return this.line_control;
        });
        io.register_write(port | 3, this, (out_byte) =>
        {
            dbg_log("line control: " + h(out_byte), LOG_SERIAL);
            this.line_control = out_byte;
        });


        io.register_read(port | 4, this, () =>
        {
            return this.modem_control;
        });
        io.register_write(port | 4, this, (out_byte) =>
        {
            dbg_log("modem control: " + h(out_byte), LOG_SERIAL);
            this.modem_control = out_byte;
        });

        io.register_read(port | 5, this, () =>
        {
            dbg_log("read line status: " + h(this.lsr), LOG_SERIAL);
            return this.lsr;
        });
        io.register_write(port | 5, this, (out_byte) =>
        {
            dbg_log("Factory test write", LOG_SERIAL);
        });

        io.register_read(port | 6, this, () =>
        {
            dbg_log("read modem status: " + h(this.modem_status), LOG_SERIAL);
            return this.modem_status;
        });
        io.register_write(port | 6, this, (out_byte) =>
        {
            dbg_log("Unkown register write (base+6)", LOG_SERIAL);
        });

        io.register_read(port | 7, this, () =>
        {
            return this.scratch_register;
        });
        io.register_write(port | 7, this, (out_byte) =>
        {
            this.scratch_register = out_byte;
        });
    }

    public get_state()
    {
        var state = [];

        state[0] = this.ints;
        state[1] = this.baud_rate;
        state[2] = this.line_control;
        state[3] = this.lsr;
        state[4] = this.fifo_control;
        state[5] = this.ier;
        state[6] = this.iir;
        state[7] = this.modem_control;
        state[8] = this.modem_status;
        state[9] = this.scratch_register;
        state[10] = this.irq;

        return state;
    };

    public set_state(state)
    {
        this.ints = state[0];
        this.baud_rate = state[1];
        this.line_control = state[2];
        this.lsr = state[3];
        this.fifo_control = state[4];
        this.ier = state[5];
        this.iir = state[6];
        this.modem_control = state[7];
        this.modem_status = state[8];
        this.scratch_register = state[9];
        this.irq = state[10];
    };

    public CheckInterrupt() {
        if ((this.ints & (1 << UART_IIR_CTI))  && (this.ier & UART_IER_RDI)) {
            this.iir = UART_IIR_CTI;
            this.cpu.device_raise_irq(this.irq);
        } else
        if ((this.ints & (1 << UART_IIR_THRI)) && (this.ier & UART_IER_THRI)) {
            this.iir = UART_IIR_THRI;
            this.cpu.device_raise_irq(this.irq);
        } else
        if ((this.ints & (1 << UART_IIR_MSI))  && (this.ier & UART_IER_MSI)) {
            this.iir = UART_IIR_MSI;
            this.cpu.device_raise_irq(this.irq);
        } else {
            this.iir = UART_IIR_NO_INT;
            this.cpu.device_lower_irq(this.irq);
        }
    };

    public ThrowInterrupt(line) {
        this.ints |= (1 << line);
        this.CheckInterrupt();
    }

    public ClearInterrupt(line) {
        this.ints &= ~(1 << line);
        this.CheckInterrupt();
    };

    /**
     * @param {number} data
     */
    public data_received(data)
    {
        dbg_log("input: " + h(data), LOG_SERIAL);
        this.input.push(data);

        this.lsr |= UART_LSR_DATA_READY;
        this.ThrowInterrupt(UART_IIR_CTI);
    };
}

import { dbg_log, dbg_assert } from "./log";

export var v86util = v86util || {};

// pad string with spaces on the right
v86util.pads = (str, len) =>
{
    str = str ? str + "" : "";

    while(str.length < len)
    {
        str = str + " ";
    }

    return str;
};

// pad string with zeros on the left
v86util.pad0 = (str, len) =>
{
    str = str ? str + "" : "";

    while(str.length < len)
    {
        str = "0" + str;
    }

    return str;
}

/**
 * number to hex
 */
export function h(n: number, len?: number): string
{
    if(!n)
    {
        var str = "";
    }
    else
    {
        var str = n.toString(16);
    }

    return "0x" + v86util.pad0(str.toUpperCase(), len || 1);
}

/**
 * Synchronous access to ArrayBuffer
 */
export class SyncBuffer
{
    private byteLength: number;
    private onload: any = undefined;
    private onprogress: any = undefined;

    constructor(private buffer)
    {
        this.byteLength = buffer.byteLength;
    }

    public load()
    {
        this.onload && this.onload({ buffer: this.buffer });
    }

    public get(start: number, len: number, fn: (arr: Uint8Array) => void): void
    {
        dbg_assert(start + len <= this.byteLength);
        fn(new Uint8Array(this.buffer, start, len));
    }

    public set(start: number, slice: Uint8Array, fn: () => void): void
    {
        dbg_assert(start + slice.byteLength <= this.byteLength);

        new Uint8Array(this.buffer, start, slice.byteLength).set(slice);
        fn();
    }

    public get_buffer(fn: (arr: Uint8Array) => void)
    {
        fn(this.buffer);
    }
}


(function()
{
    var int_log2_table = new Int8Array(256);

    for(var i = 0, b = -2; i < 256; i++)
    {
        if(!(i & i - 1))
            b++;

        int_log2_table[i] = b;
    }

    /**
     * calculate the integer logarithm base 2 of a byte
     * @param {number} x
     * @return {number}
     */
    v86util.int_log2_byte = (x) =>
    {
        dbg_assert(x > 0);
        dbg_assert(x < 0x100);

        return int_log2_table[x];
    };

    /**
     * calculate the integer logarithm base 2
     * @param {number} x
     * @return {number}
     */
    v86util.int_log2 = (x) =>
    {
        dbg_assert(x > 0);

        // http://jsperf.com/integer-log2/6
        var tt = x >>> 16;

        if(tt)
        {
            var t = tt >>> 8;
            if(t)
            {
                return 24 + int_log2_table[t];
            }
            else
            {
                return 16 + int_log2_table[tt];
            }
        }
        else
        {
            var t = x >>> 8;
            if(t)
            {
                return 8 + int_log2_table[t];
            }
            else
            {
                return int_log2_table[x];
            }
        }
    }
})();


/**
 * Queue wrapper around Uint8Array
 * Used by devices such as the PS2 controller
 */
export class ByteQueue
{
    public length = 0;
    private data: Uint8Array;
    private start: number;
    private end: number;

    constructor(private size: number)
    {
        this.data = new Uint8Array(size);
        dbg_assert((size & size - 1) === 0);
        this.clear();
    }

    public push(item)
    {
        if(this.length === this.size)
        {
            // intentional overwrite
        }
        else
        {
            this.length++;
        }

        this.data[this.end] = item;
        this.end = this.end + 1 & this.size - 1;
    }

    public shift()
    {
        if(!this.length)
        {
            return -1;
        }
        else
        {
            var item = this.data[this.start];

            this.start = this.start + 1 & this.size - 1;
            this.length--;

            return item;
        }
    }

    public peek()
    {
        if(!this.length)
        {
            return -1;
        }
        else
        {
            return this.data[this.start];
        }
    }

    public clear()
    {
        this.start = 0;
        this.end = 0;
        this.length = 0;
    }
}


/**
 * Simple circular queue for logs
 */
export class CircularQueue
{
    private data: any[] = [];
    private index = 0;

    constructor(private size: number)
    {
    }

    public add(item)
    {
        this.data[this.index] = item;
        this.index = (this.index + 1) % this.size;
    }

    public toArray()
    {
        return [].slice.call(this.data, this.index).concat([].slice.call(this.data, 0, this.index));
    }

    public clear()
    {
        this.data = [];
        this.index = 0;
    }

    public set(new_data: any[])
    {
        this.data = new_data;
        this.index = 0;
    }
}
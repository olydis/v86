/** @const */
var ASYNC_SAFE = false;

// if(typeof XMLHttpRequest === "undefined")
// {
//     v86util.load_file = load_file_nodejs;
// }
// else
// {
//     v86util.load_file = load_file;
// }

/**
 * @param {string} filename
 * @param {Object} options
 */
export function load_file(filename, options)
{
    var http = new XMLHttpRequest();

    http.open(options.method || "get", filename, true);

    if(!options.as_text)
    {
        http.responseType = "arraybuffer";
    }

    if(options.headers)
    {
        var header_names = Object.keys(options.headers);

        for(var i = 0; i < header_names.length; i++)
        {
            var name = header_names[i];
            http.setRequestHeader(name, options.headers[name]);
        }
    }

    http.onload = (e) =>
    {
        if(http.readyState === 4)
        {
            if(http.status !== 200 && http.status !== 206)
            {
                console.error("Loading the image `" + filename + "` failed (status %d)", http.status);
            }
            else if(http.response)
            {
                options.done && options.done(http.response, http);
            }
        }
    };

    if(options.progress)
    {
        http.onprogress = (e) =>
        {
            options.progress(e);
        };
    }

    http.send(null);
}

// function load_file_nodejs(filename, options)
// {
//     var o = {
//         encoding: options.as_text ? "utf-8" : null,
//     };

//     require("fs")["readFile"](filename, o, function(err, data)
//     {
//         if(err)
//         {
//             console.log("Could not read file:", filename);
//         }
//         else
//         {
//             var result = data;

//             if(!options.as_text)
//             {
//                 result = new Uint8Array(result).buffer;
//             }

//             options.done(result);
//         }
//     });
// }

/**
 * Asynchronous access to ArrayBuffer, loading blocks lazily as needed,
 * using the `Range: bytes=...` header
 */
export class AsyncXHRBuffer
{
    private readonly block_size = 256;

    private loaded_blocks = {};

    private onload = undefined;
    private onprogress = undefined;

    constructor(private filename: string, private byteLength: number)
    {
    }

    public load()
    {
        if(this.byteLength !== undefined)
        {
            this.onload && this.onload({});
            return;
        }

        // Determine the size using a request

        load_file(this.filename, {
            done: (buffer, http) =>
            {
                var header = http.getResponseHeader("Content-Range") || "";
                var match = header.match(/\/(\d+)\s*$/);

                if(match)
                {
                    this.byteLength = +match[1]
                    this.onload && this.onload({});
                }
                else
                {
                    console.assert(false,
                        "Cannot use: " + this.filename + ". " +
                        "`Range: bytes=...` header not supported (Got `" + header + "`)");
                }
            },
            headers: {
                Range: "bytes=0-0",

                //"Accept-Encoding": "",

                // Added by Chromium, but can cause the whole file to be sent
                // Settings this to empty also causes problems and Chromium
                // doesn't seem to create this header any more
                //"If-Range": "",
            }
        });
    }

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    public get_from_cache(offset, len, fn)
    {
        var number_of_blocks = len / this.block_size;
        var block_index = offset / this.block_size;

        for(var i = 0; i < number_of_blocks; i++)
        {
            var block = this.loaded_blocks[block_index + i];

            if(!block)
            {
                return;
            }
        }

        if(number_of_blocks === 1)
        {
            return this.loaded_blocks[block_index];
        }
        else
        {
            var result = new Uint8Array(len);
            for(var i = 0; i < number_of_blocks; i++)
            {
                result.set(this.loaded_blocks[block_index + i], i * this.block_size);
            }
            return result;
        }
    }

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    public get(offset, len, fn)
    {
        console.assert(offset + len <= this.byteLength);
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len, fn);
        if(block)
        {
            if(ASYNC_SAFE)
            {
                setTimeout(fn.bind(this, block), 0);
            }
            else
            {
                fn(block);
            }
            return;
        }

        var range_start = offset;
        var range_end = offset + len - 1;

        load_file(this.filename, {
            done: (buffer) =>
            {
                var block = new Uint8Array(buffer);
                this.handle_read(offset, len, block);
                fn(block);
            },
            headers: {
                Range: "bytes=" + range_start + "-" + range_end,
            }
        });
    }

    /**
     * Relies on this.byteLength, this.loaded_blocks and this.block_size
     *
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     *
     * @param {number} start
     * @param {!Uint8Array} data
     * @param {function()} fn
     */
    public set(start, data, fn)
    {
        console.assert(start + data.byteLength <= this.byteLength);

        var len = data.length;

        console.assert(start % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var start_block = start / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var block = this.loaded_blocks[start_block + i];

            if(block === undefined)
            {
                block = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            }

            var data_slice = data.subarray(i * this.block_size, (i + 1) * this.block_size);
            block.set(data_slice);

            console.assert(block.byteLength === data_slice.length);
        }

        fn();
    }

    /**
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     * @param {number} offset
     * @param {number} len
     * @param {!Uint8Array} block
     */
    public handle_read(offset, len, block)
    {
        // Used by AsyncXHRBuffer and AsyncFileBuffer
        // Overwrites blocks from the original source that have been written since

        var start_block = offset / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var written_block = this.loaded_blocks[start_block + i];

            if(written_block)
            {
                block.set(written_block, i * this.block_size);
            }
            //else
            //{
            //    var cached = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            //    cached.set(block.subarray(i * this.block_size, (i + 1) * this.block_size));
            //}
        }
    }

    public get_buffer(fn)
    {
        // We must download all parts, unlikely a good idea for big files
        fn();
    }
}


/**
 * Synchronous access to File, loading blocks from the input type=file
 * The whole file is loaded into memory during initialisation
 */
export class SyncFileBuffer
{
    private byteLength: number;
    private buffer: ArrayBuffer;
    private onload: any = undefined;
    private onprogress: any = undefined;

    constructor(private file)
    {
        this.byteLength = file.size;

        if(file.size > (1 << 30))
        {
            console.warn("SyncFileBuffer: Allocating buffer of " + (file.size >> 20) + " MB ...");
        }

        this.buffer = new ArrayBuffer(file.size);
    }

    public load()
    {
        this.load_next(0);
    }

    /**
     * @param {number} start
     */
    public load_next(start)
    {
        /** @const */
        var PART_SIZE = 4 << 20;

        var filereader = new FileReader();

        filereader.onload = (e) =>
        {
            var buffer = new Uint8Array((<any>e.target).result);
            new Uint8Array(this.buffer, start).set(buffer);
            this.load_next(start + PART_SIZE);
        };

        if(this.onprogress)
        {
            this.onprogress({
                loaded: start,
                total: this.byteLength,
                lengthComputable: true,
            });
        }

        if(start < this.byteLength)
        {
            var end = Math.min(start + PART_SIZE, this.byteLength);
            var slice = this.file.slice(start, end);
            filereader.readAsArrayBuffer(slice);
        }
        else
        {
            this.file = undefined;
            this.onload && this.onload({ buffer: this.buffer });
        }
    }

    /**
     * @param {number} start
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    public get(start, len, fn)
    {
        console.assert(start + len <= this.byteLength);
        fn(new Uint8Array(this.buffer, start, len));
    };

    /**
     * @param {number} offset
     * @param {!Uint8Array} slice
     * @param {function()} fn
     */
    public set(offset, slice, fn)
    {
        console.assert(offset + slice.byteLength <= this.byteLength);

        new Uint8Array(this.buffer, offset, slice.byteLength).set(slice);
        fn();
    };

    public get_buffer(fn)
    {
        fn(this.buffer);
    };
}

/**
 * Asynchronous access to File, loading blocks from the input type=file
 */
export class AsyncFileBuffer
{
    private byteLength: number;

    private readonly block_size = 256
    private loaded_blocks = {};

    private onload = undefined;
    private onprogress = undefined;

    constructor(private file)
    {
        this.byteLength = file.size;
    }

    public load()
    {
        this.onload && this.onload({});
    }

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    public get(offset, len, fn)
    {
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len, fn);
        if(block)
        {
            fn(block);
            return;
        }

        var fr = new FileReader();

        fr.onload = (e) =>
        {
            var buffer = (<any>e.target).result;
            var block = new Uint8Array(buffer);

            this.handle_read(offset, len, block);
            fn(block);
        };

        fr.readAsArrayBuffer(this.file.slice(offset, offset + len));
    }


    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    public get_from_cache(offset, len, fn)
    {
        var number_of_blocks = len / this.block_size;
        var block_index = offset / this.block_size;

        for(var i = 0; i < number_of_blocks; i++)
        {
            var block = this.loaded_blocks[block_index + i];

            if(!block)
            {
                return;
            }
        }

        if(number_of_blocks === 1)
        {
            return this.loaded_blocks[block_index];
        }
        else
        {
            var result = new Uint8Array(len);
            for(var i = 0; i < number_of_blocks; i++)
            {
                result.set(this.loaded_blocks[block_index + i], i * this.block_size);
            }
            return result;
        }
    }

    /**
     * Relies on this.byteLength, this.loaded_blocks and this.block_size
     *
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     *
     * @param {number} start
     * @param {!Uint8Array} data
     * @param {function()} fn
     */
    public set(start, data, fn)
    {
        console.assert(start + data.byteLength <= this.byteLength);

        var len = data.length;

        console.assert(start % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var start_block = start / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var block = this.loaded_blocks[start_block + i];

            if(block === undefined)
            {
                block = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            }

            var data_slice = data.subarray(i * this.block_size, (i + 1) * this.block_size);
            block.set(data_slice);

            console.assert(block.byteLength === data_slice.length);
        }

        fn();
    }

    /**
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     * @param {number} offset
     * @param {number} len
     * @param {!Uint8Array} block
     */
    public handle_read(offset, len, block)
    {
        // Used by AsyncXHRBuffer and AsyncFileBuffer
        // Overwrites blocks from the original source that have been written since

        var start_block = offset / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var written_block = this.loaded_blocks[start_block + i];

            if(written_block)
            {
                block.set(written_block, i * this.block_size);
            }
            //else
            //{
            //    var cached = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            //    cached.set(block.subarray(i * this.block_size, (i + 1) * this.block_size));
            //}
        }
    }

    public get_buffer(fn)
    {
        // We must load all parts, unlikely a good idea for big files
        fn();
    };

    public get_as_file(name)
    {
        var parts = [];
        var existing_blocks = Object.keys(this.loaded_blocks)
                                .map(Number)
                                .sort(function(x, y) { return x - y; });

        var current_offset = 0;

        for(var i = 0; i < existing_blocks.length; i++)
        {
            var block_index = existing_blocks[i];
            var block = this.loaded_blocks[block_index];
            var start = block_index * this.block_size;
            console.assert(start >= current_offset);

            if(start !== current_offset)
            {
                parts.push(this.file.slice(current_offset, start));
                current_offset = start;
            }

            parts.push(block);
            current_offset += block.length;
        }

        if(current_offset !== this.file.size)
        {
            parts.push(this.file.slice(current_offset));
        }

        var file = new File(parts, name);
        console.assert(file.size === this.file.size);

        return file;
    };
}
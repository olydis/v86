
import { dbg_log, dbg_assert } from "./log";

/** @const */
export var STATE_VERSION = 3;

/** @const */
export var STATE_MAGIC = 0x86768676|0;

/** @const */
export var STATE_INDEX_MAGIC = 0;

/** @const */
export var STATE_INDEX_VERSION = 1;

/** @const */
export var STATE_INDEX_TOTAL_LEN = 2;

/** @const */
export var STATE_INDEX_INFO_LEN = 3;

/** @const */
export var STATE_INFO_BLOCK_START = 16;

export class StateLoadError extends Error
{

}

export function save_object(obj, saved_buffers)
{
    if(typeof obj !== "object" || obj === null || obj instanceof Array)
    {
        return obj;
    }

    dbg_assert(obj.constructor !== Object);

    if(obj.BYTES_PER_ELEMENT)
    {
        // Uint8Array, etc.
        var buffer = new Uint8Array(obj.buffer, obj.byteOffset, obj.length * obj.BYTES_PER_ELEMENT);

        return {
            "__state_type__": obj.constructor.name,
            "buffer_id": saved_buffers.push(buffer) - 1,
        };
    }

    if(DEBUG && !obj.get_state)
    {
        console.log("Object without get_state: ", obj);
    }

    var state = obj.get_state();
    var result = [];

    for(var i = 0; i < state.length; i++)
    {
        var value = state[i];

        dbg_assert(typeof value !== "function");

        result[i] = save_object(value, saved_buffers);
    }

    return result;
}

export function restore_object(base, obj, buffers)
{
    // recursively restore obj into base

    if(typeof obj !== "object" || obj === null)
    {
        return obj;
    }

    if(base instanceof Array)
    {
        return obj;
    }

    var type = obj["__state_type__"];

    if(type === undefined)
    {
        if(DEBUG && base === undefined)
        {
            console.log("Cannot restore (base doesn't exist)", obj);
            dbg_assert(false);
        }

        if(DEBUG && !base.get_state)
        {
            console.log("No get_state:", base);
        }

        var current = base.get_state();

        dbg_assert(current.length === obj.length, "Cannot restore: Different number of properties");

        for(var i = 0; i < obj.length; i++)
        {
            obj[i] = restore_object(current[i], obj[i], buffers);
        }

        base.set_state(obj);

        return base;
    }
    else
    {
        var table = {
            "Uint8Array": Uint8Array,
            "Int8Array": Int8Array,
            "Uint16Array": Uint16Array,
            "Int16Array": Int16Array,
            "Uint32Array": Uint32Array,
            "Int32Array": Int32Array,
            "Float32Array": Float32Array,
            "Float64Array": Float64Array,
        };

        var constructor = table[type];
        dbg_assert(constructor, "Unkown type: " + type);

        var info = buffers.infos[obj["buffer_id"]];

        dbg_assert(base);
        dbg_assert(base.constructor === constructor);

        // restore large buffers by just returning a view on the state blob
        if(info.length >= 1024 * 1024 && constructor === Uint8Array)
        {
            return new Uint8Array(buffers.full, info.offset, info.length);
        }
        // XXX: Disabled, unpredictable since it updates in-place, breaks pci
        //      and possibly also breaks restore -> save -> restore again
        // avoid a new allocation if possible
        //else if(base &&
        //        base.constructor === constructor &&
        //        base.byteOffset === 0 &&
        //        base.byteLength === info.length)
        //{
        //    new Uint8Array(base.buffer).set(
        //        new Uint8Array(buffers.full, info.offset, info.length),
        //        base.byteOffset
        //    );
        //    return base;
        //}
        else
        {
            var buf = buffers.full.slice(info.offset, info.offset + info.length);
            return new constructor(buf);
        }
    }
}
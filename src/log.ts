import * as v86util from "./lib";

export var log_data = [];

function do_the_log(message)
{
    if(LOG_TO_FILE)
    {
        log_data.push(message);
    }
    else
    {
        //console.log(message);
    }
}

/**
 * @type {((string|number) =>, number=)}
 * @const
 */
export var dbg_log = (() =>
{
    /** @const @type {Object.<number, string>} */
    var dbg_names = LOG_NAMES.reduce((a, x) =>
    {
        a[x[0]] = x[1];
        return a;
    }, {});

    var log_last_message = "";
    var log_message_repetitions = 0;

    /**
     * @param {number=} level
     */
    function dbg_log_(stuff: any, level?: number)
    {
        if(!DEBUG) return;

        level = level || 1;

        if(level & LOG_LEVEL)
        {
            var level_name = dbg_names[level] || "",
                message = "[" + v86util.pads(level_name, 4) + "] " + stuff;

            if(message === log_last_message)
            {
                log_message_repetitions++;

                if(log_message_repetitions < 2048)
                {
                    return;
                }
            }

            var now = new Date();
            var time_str = v86util.pad0(now.getHours(), 2) + ":" +
                           v86util.pad0(now.getMinutes(), 2) + ":" +
                           v86util.pad0(now.getSeconds(), 2) + "+" +
                           v86util.pad0(now.getMilliseconds(), 3) + " ";

            if(log_message_repetitions)
            {
                if(log_message_repetitions === 1)
                {
                    do_the_log(time_str + log_last_message);
                }
                else
                {
                    do_the_log("Previous message repeated " + log_message_repetitions + " times");
                }

                log_message_repetitions = 0;
            }

            do_the_log(time_str + message);
            log_last_message = message;
        }
    }

    return dbg_log_;
})();

export function dbg_trace(level?: number)
{
    if(!DEBUG) return;

    dbg_log(Error().stack.replace(/(?:(?:t|t16|t32)\.\(anonymous function\)\.)+/g, "t.(anonymous function)."), level);
}

/**
 * console.assert is fucking slow (<- wise words)
 */
export function dbg_assert(cond: boolean, msg?: string, level?: number)
{
    if(!DEBUG) return;

    if(!cond)
    {
        console.trace();

        if(msg)
        {
            throw "Assert failed: " + msg;
        }
        else
        {
            throw "Assert failed";
        }
    }
}



import { dbg_log, dbg_assert, dbg_trace } from "../log";

module WorkerBus
{
    class Connector
    {
        private listeners = {};

        constructor(private pair)
        {
            pair.addEventListener("message", (e) =>
            {
                var data = e.data;
                var listeners = this.listeners[data[0]];

                for(var i = 0; i < listeners.length; i++)
                {
                    var listener = listeners[i];
                    listener.fn.call(listener.this_value, data[1]);
                }
            }, false);
        }

        public register(name, fn, this_value)
        {
            var listeners = this.listeners[name];

            if(listeners === undefined)
            {
                listeners = this.listeners[name] = [];
            }

            listeners.push({
                fn: fn,
                this_value: this_value,
            });
        }

        /**
         * Send ("emit") a message
         *
         * @param {string} name
         * @param {*=} value
         * @param {*=} transfer_list
         */
        public send(name, value, transfer_list)
        {
            dbg_assert(arguments.length >= 1);

            if(!this.pair)
            {
                return;
            }

            this.pair.postMessage([name, value], transfer_list);
        }
    }

    function init(worker)
    {
        return new Connector(worker);
    }
}




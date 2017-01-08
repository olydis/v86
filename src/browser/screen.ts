import { BusConnector } from "../bus";

if(typeof window !== "undefined" && !window.requestAnimationFrame)
{
    window.requestAnimationFrame =
        (<any>window).mozRequestAnimationFrame ||
        (<any>window).webkitRequestAnimationFrame;
}


/**
 * Adapter to use visual screen in browsers (in constrast to node)
 */
export class ScreenAdapter
{
    private graphic_screen: HTMLCanvasElement;
    private graphic_context: CanvasRenderingContext2D;

    private text_screen: any;
    private cursor_element = document.createElement("div");

    private graphic_image_data: any;
    private graphic_buffer: any;
    private graphic_buffer32: any;

    private cursor_row: number;
    private cursor_col: number;
    private scale_x = 1;
    private scale_y = 1;

    private graphical_mode_width: number;
    private graphical_mode_height: number;

    private modified_pixel_min = 0;
    private modified_pixel_max = 0;

    private changed_rows: any;

    // are we in graphical mode now?
    private is_graphical = false;

    // Index 0: ASCII code
    // Index 1: Background color
    // Index 2: Foreground color
    private text_mode_data: any;

    // number of columns
    private text_mode_width: number;

    // number of rows
    private text_mode_height: number;

    private charmap = [];

    constructor(screen_container, private bus: BusConnector)
    {
        console.assert(screen_container, "1st argument must be a DOM container");

        this.graphic_screen = screen_container.getElementsByTagName("canvas")[0];
        this.graphic_context = this.graphic_screen.getContext("2d");

        this.text_screen = this.graphic_screen.nextElementSibling || this.graphic_screen.previousElementSibling;

        /**
         * Charmaps that containt unicode sequences for the default dospage
         * @const
         */
        var charmap_high = new Uint16Array([
            0xC7, 0xFC, 0xE9, 0xE2, 0xE4, 0xE0, 0xE5, 0xE7,
            0xEA, 0xEB, 0xE8, 0xEF, 0xEE, 0xEC, 0xC4, 0xC5,
            0xC9, 0xE6, 0xC6, 0xF4, 0xF6, 0xF2, 0xFB, 0xF9,
            0xFF, 0xD6, 0xDC, 0xA2, 0xA3, 0xA5, 0x20A7, 0x192,
            0xE1, 0xED, 0xF3, 0xFA, 0xF1, 0xD1, 0xAA, 0xBA,
            0xBF, 0x2310, 0xAC, 0xBD, 0xBC, 0xA1, 0xAB, 0xBB,
            0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
            0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
            0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
            0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
            0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
            0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
            0x3B1, 0xDF, 0x393, 0x3C0, 0x3A3, 0x3C3, 0xB5, 0x3C4,
            0x3A6, 0x398, 0x3A9, 0x3B4, 0x221E, 0x3C6, 0x3B5, 0x2229,
            0x2261, 0xB1, 0x2265, 0x2264, 0x2320, 0x2321, 0xF7,
            0x2248, 0xB0, 0x2219, 0xB7, 0x221A, 0x207F, 0xB2, 0x25A0, 0xA0
        ]);

        /** @const */
        var charmap_low = new Uint16Array([
            0x20,   0x263A, 0x263B, 0x2665, 0x2666, 0x2663, 0x2660, 0x2022,
            0x25D8, 0x25CB, 0x25D9, 0x2642, 0x2640, 0x266A, 0x266B, 0x263C,
            0x25BA, 0x25C4, 0x2195, 0x203C, 0xB6,   0xA7,   0x25AC, 0x21A8,
            0x2191, 0x2193, 0x2192, 0x2190, 0x221F, 0x2194, 0x25B2, 0x25BC
        ]);

        var chr;

        for(var i = 0; i < 256; i++)
        {
            if(i > 127)
            {
                chr = charmap_high[i - 0x80];
            }
            else if(i < 32)
            {
                chr = charmap_low[i];
            }
            else
            {
                chr = i;
            }

            this.charmap[i] = String.fromCharCode(chr);
        }

        this.graphic_context["imageSmoothingEnabled"] = false;
        this.graphic_context["mozImageSmoothingEnabled"] = false;

        this.cursor_element.style.position = "absolute";
        this.cursor_element.style.backgroundColor = "#ccc";
        this.cursor_element.style.width = "7px";
        this.cursor_element.style.display = "inline-block";

        this.text_screen.style.display = "block";
        this.graphic_screen.style.display = "none";

        bus.register("screen-set-mode", (data) =>
        {
            this.set_mode(data);
        }, this);

        bus.register("screen-fill-buffer-end", (data) =>
        {
            var min = data[0];
            var max = data[1];

            this.update_buffer(min, max);
        }, this);

        bus.register("screen-put-char", (data) =>
        {
            //console.log(data);
            this.put_char(data[0], data[1], data[2], data[3], data[4]);
        }, this);

        bus.register("screen-text-scroll", (rows) =>
        {
            console.log("scroll", rows);
        }, this);

        bus.register("screen-update-cursor", (data) =>
        {
            this.update_cursor(data[0], data[1]);
        }, this);
        bus.register("screen-update-cursor-scanline", (data) =>
        {
            this.update_cursor_scanline(data[0], data[1]);
        }, this);

        bus.register("screen-set-size-text", (data) =>
        {
            this.set_size_text(data[0], data[1]);
        }, this);
        bus.register("screen-set-size-graphical", (data) =>
        {
            this.set_size_graphical(data[0], data[1]);
        }, this);

        this.set_scale(this.scale_x, this.scale_y);
        this.init();
    }

    // 0x12345 -> "#012345"
    public number_as_color(n)
    {
        n = n.toString(16);

        return "#" + Array(7 - n.length).join("0") + n;
    }

    public init()
    {
        // not necessary, because this gets initialized by the bios early,
        // but nicer to look at
        this.set_size_text(80, 25);

        this.timer();
    }

    public make_screenshot()
    {
        try {
            window.open(this.graphic_screen.toDataURL());
        }
        catch(e) {}
    }

    public put_char(row, col, chr, bg_color, fg_color)
    {
        if(row < this.text_mode_height && col < this.text_mode_width)
        {
            var p = 3 * (row * this.text_mode_width + col);

            this.text_mode_data[p] = chr;
            this.text_mode_data[p + 1] = bg_color;
            this.text_mode_data[p + 2] = fg_color;

            this.changed_rows[row] = 1;
        }
    }

    public timer()
    {
        requestAnimationFrame(this.is_graphical ? this.update_graphical : this.update_text);
    }

    public update_text()
    {
        for(var i = 0; i < this.text_mode_height; i++)
        {
            if(this.changed_rows[i])
            {
                this.text_update_row(i);
                this.changed_rows[i] = 0;
            }
        }

        this.timer();
    }

    public update_graphical()
    {
        this.bus.send("screen-fill-buffer");

        this.timer();
    }

    public destroy()
    {
    }

    public set_mode(graphical)
    {
        this.is_graphical = graphical;

        if(graphical)
        {
            this.text_screen.style.display = "none";
            this.graphic_screen.style.display = "block";
        }
        else
        {
            this.text_screen.style.display = "block";
            this.graphic_screen.style.display = "none";
        }
    }

    public clear_screen()
    {
        this.graphic_context.fillStyle = "#000";
        this.graphic_context.fillRect(0, 0, this.graphic_screen.width, this.graphic_screen.height);
    }

    public set_size_text(cols: number, rows: number)
    {
        if(cols === this.text_mode_width && rows === this.text_mode_height)
        {
            return;
        }

        this.changed_rows = new Int8Array(rows);
        this.text_mode_data = new Int32Array(cols * rows * 3);

        this.text_mode_width = cols;
        this.text_mode_height = rows;

        while(this.text_screen.childNodes.length > rows)
        {
            this.text_screen.removeChild(this.text_screen.firstChild);
        }

        while(this.text_screen.childNodes.length < rows)
        {
            this.text_screen.appendChild(document.createElement("div"));
        }

        for(var i = 0; i < rows; i++)
        {
            this.text_update_row(i);
        }
    }

    public set_size_graphical(width, height)
    {
        this.graphic_screen.style.display = "block";

        this.graphic_screen.width = width;
        this.graphic_screen.height = height;

        //graphic_screen.style.width = width * scale_x + "px";
        //graphic_screen.style.height = height * scale_y + "px";

        // Make sure to call this here, because pixels are transparent otherwise
        //screen.clear_screen();

        this.graphic_image_data = this.graphic_context.createImageData(width, height);
        this.graphic_buffer = new Uint8Array(this.graphic_image_data.data.buffer);
        this.graphic_buffer32 = new Int32Array(this.graphic_image_data.data.buffer);

        this.graphical_mode_width = width;
        this.graphical_mode_height = height;

        this.bus.send("screen-tell-buffer", [this.graphic_buffer32], [this.graphic_buffer32.buffer]);
    }

    public set_scale(s_x, s_y)
    {
        this.scale_x = s_x;
        this.scale_y = s_y;

        this.elem_set_scale(this.graphic_screen, this.scale_x, this.scale_y);
        this.elem_set_scale(this.text_screen, this.scale_x, this.scale_y);
    }

    public elem_set_scale(elem, scale_x, scale_y)
    {
        var scale_str = "";

        scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
        scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

        elem.style.webkitTransform = elem.style.MozTransform = scale_str;
    }

    public update_cursor_scanline(start, end)
    {
        if(start & 0x20)
        {
            this.cursor_element.style.display = "none";
        }
        else
        {
            this.cursor_element.style.display = "inline";

            this.cursor_element.style.height = Math.min(15, end - start) + "px";
            this.cursor_element.style.marginTop = Math.min(15, start) + "px";
        }
    }

    public update_cursor(row, col)
    {
        if(row !== this.cursor_row || col !== this.cursor_col)
        {
            this.changed_rows[row] = 1;
            this.changed_rows[this.cursor_row] = 1;

            this.cursor_row = row;
            this.cursor_col = col;
        }
    }

    public text_update_row(row)
    {
        var offset = 3 * row * this.text_mode_width,
            row_element,
            color_element,
            fragment;

        var bg_color,
            fg_color,
            text;

        row_element = this.text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(var i = 0; i < this.text_mode_width; )
        {
            color_element = document.createElement("span");

            bg_color = this.text_mode_data[offset + 1];
            fg_color = this.text_mode_data[offset + 2];

            color_element.style.backgroundColor = this.number_as_color(bg_color);
            color_element.style.color = this.number_as_color(fg_color);

            text = "";

            // put characters of the same color in one element
            while(i < this.text_mode_width
                    && this.text_mode_data[offset + 1] === bg_color
                    && this.text_mode_data[offset + 2] === fg_color)
            {
                var ascii = this.text_mode_data[offset];

                text += this.charmap[ascii];

                i++;
                offset += 3;

                if(row === this.cursor_row)
                {
                    if(i === this.cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === this.cursor_col + 1)
                    {
                        // found the cursor
                        fragment.appendChild(this.cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    }

    public update_buffer(min, max)
    {
        if(max < min)
        {
            return;
        }

        var min_y = min / this.graphical_mode_width | 0;
        var max_y = max / this.graphical_mode_width | 0;

        this.graphic_context.putImageData(
            this.graphic_image_data,
            0, 0,
            0, min_y,
            this.graphical_mode_width, max_y - min_y + 1
        );
    }
}
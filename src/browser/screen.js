"use strict";

if(typeof window !== "undefined" && !window.requestAnimationFrame)
{
    window.requestAnimationFrame =
        window.mozRequestAnimationFrame ||
        window.webkitRequestAnimationFrame;
}


/**
 * Adapter to use visual screen in browsers (in constrast to node)
 * @constructor
 *
 * @param {BusConnector} bus
 */
function ScreenAdapter(screen_container, bus)
{
    console.assert(screen_container, "1st argument must be a DOM container");

    var
        graphic_screen = screen_container.getElementsByTagName("canvas")[0],
        graphic_context = graphic_screen.getContext("2d"),

        text_screen = graphic_screen.nextElementSibling || graphic_screen.previousElementSibling,
        cursor_element = document.createElement("div");

    var
        graphic_image_data,
        graphic_buffer,
        graphic_buffer32,

        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        /** @type {number} */
        scale_x = 1,

        /** @type {number} */
        scale_y = 1,

        graphical_mode_width,
        graphical_mode_height,

        modified_pixel_min = 0,
        modified_pixel_max = 0,

        changed_rows,

        // are we in graphical mode now?
        is_graphical = false,

        // Index 0: ASCII code
        // Index 1: Background color
        // Index 2: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height;

    var screen = this;

    // 0x12345 -> "#012345"
    function number_as_color(n)
    {
        n = n.toString(16);

        return "#" + Array(7 - n.length).join("0") + n;
    }


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

    var charmap = [],
        chr;

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

        charmap[i] = String.fromCharCode(chr);
    }

    graphic_context["imageSmoothingEnabled"] = false;
    graphic_context["mozImageSmoothingEnabled"] = false;

    cursor_element.style.position = "absolute";
    cursor_element.style.backgroundColor = "#ccc";
    cursor_element.style.width = "7px";
    cursor_element.style.display = "inline-block";

    text_screen.style.display = "block";
    graphic_screen.style.display = "none";

    this.bus = bus;

    bus.register("screen-set-mode", function(data)
    {
        this.set_mode(data);
    }, this);

    bus.register("screen-fill-buffer-end", function(data)
    {
        var min = data[0];
        var max = data[1];

        this.update_buffer(min, max);
    }, this);

    bus.register("screen-put-char", function(data)
    {
        //console.log(data);
        this.put_char(data[0], data[1], data[2], data[3], data[4]);
    }, this);

    bus.register("screen-text-scroll", function(rows)
    {
        console.log("scroll", rows);
    }, this);

    bus.register("screen-update-cursor", function(data)
    {
        this.update_cursor(data[0], data[1]);
    }, this);
    bus.register("screen-update-cursor-scanline", function(data)
    {
        this.update_cursor_scanline(data[0], data[1]);
    }, this);

    bus.register("screen-set-size-text", function(data)
    {
        this.set_size_text(data[0], data[1]);
    }, this);
    bus.register("screen-set-size-graphical", function(data)
    {
        this.set_size_graphical(data[0], data[1]);
    }, this);


    this.init = function()
    {
        // not necessary, because this gets initialized by the bios early,
        // but nicer to look at
        this.set_size_text(80, 25);

        this.timer();
    };

    this.make_screenshot = function()
    {
        try {
            window.open(graphic_screen.toDataURL());
        }
        catch(e) {}
    };

    this.put_char = function(row, col, chr, bg_color, fg_color)
    {
        if(row < text_mode_height && col < text_mode_width)
        {
            var p = 3 * (row * text_mode_width + col);

            text_mode_data[p] = chr;
            text_mode_data[p + 1] = bg_color;
            text_mode_data[p + 2] = fg_color;

            changed_rows[row] = 1;
        }
    };

    this.timer = function()
    {
        requestAnimationFrame(is_graphical ? update_graphical : update_text);
    };

    function update_text()
    {
        //var max_consecutive = 0;
        //var consecutive = 0;
        //for(var i = 0; i < text_mode_height; i++)
        //{
        //    if(changed_rows[i])
        //    {
        //        if(consecutive === max_consecutive)
        //            max_consecutive++;
        //        consecutive++;
        //    }
        //    else
        //    {
        //        consecutive = 0;
        //    }
        //}
        //if(max_consecutive > 1) dbg_log("consecutive rows updated: " + max_consecutive + " height=" + text_mode_height + ")");
        //if(max_consecutive === text_mode_height)
        //{
        //    var line_offset = 3 * text_mode_width;
        //    for(var i = 0; i < text_mode_height; i++)
        //    {
        //        if(text_mode_data
        //    }
        //}

        for(var i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                screen.text_update_row(i);
                changed_rows[i] = 0;
            }
        }

        this.timer();
    }
    update_text = update_text.bind(this);

    function update_graphical()
    {
        this.bus.send("screen-fill-buffer");

        this.timer();
    }
    update_graphical = update_graphical.bind(this);

    this.destroy = function()
    {
    };

    this.set_mode = function(graphical)
    {
        is_graphical = graphical;

        if(graphical)
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";
        }
        else
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
    };

    this.clear_screen = function()
    {
        graphic_context.fillStyle = "#000";
        graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
    };

    /**
     * @param {number} cols
     * @param {number} rows
     */
    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height)
        {
            return;
        }

        changed_rows = new Int8Array(rows);
        text_mode_data = new Int32Array(cols * rows * 3);

        text_mode_width = cols;
        text_mode_height = rows;

        while(text_screen.childNodes.length > rows)
        {
            text_screen.removeChild(text_screen.firstChild);
        }

        while(text_screen.childNodes.length < rows)
        {
            text_screen.appendChild(document.createElement("div"));
        }

        for(var i = 0; i < rows; i++)
        {
            this.text_update_row(i);
        }
    };

    this.set_size_graphical = function(width, height)
    {
        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;

        //graphic_screen.style.width = width * scale_x + "px";
        //graphic_screen.style.height = height * scale_y + "px";

        // Make sure to call this here, because pixels are transparent otherwise
        //screen.clear_screen();

        graphic_image_data = graphic_context.createImageData(width, height);
        graphic_buffer = new Uint8Array(graphic_image_data.data.buffer);
        graphic_buffer32 = new Int32Array(graphic_image_data.data.buffer);

        graphical_mode_width = width;
        graphical_mode_height = height;

        this.bus.send("screen-tell-buffer", [graphic_buffer32], [graphic_buffer32.buffer]);
    };

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        elem_set_scale(graphic_screen, scale_x, scale_y);
        elem_set_scale(text_screen, scale_x, scale_y);
    };
    this.set_scale(scale_x, scale_y);

    function elem_set_scale(elem, scale_x, scale_y)
    {
        var scale_str = "";

        scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
        scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

        elem.style.webkitTransform = elem.style.MozTransform = scale_str;
    }

    this.update_cursor_scanline = function(start, end)
    {
        if(start & 0x20)
        {
            cursor_element.style.display = "none";
        }
        else
        {
            cursor_element.style.display = "inline";

            cursor_element.style.height = Math.min(15, end - start) + "px";
            cursor_element.style.marginTop = Math.min(15, start) + "px";
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            changed_rows[row] = 1;
            changed_rows[cursor_row] = 1;

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        var offset = 3 * row * text_mode_width,
            row_element,
            color_element,
            fragment;

        var bg_color,
            fg_color,
            text;

        row_element = text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(var i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            bg_color = text_mode_data[offset + 1];
            fg_color = text_mode_data[offset + 2];

            color_element.style.backgroundColor = number_as_color(bg_color);
            color_element.style.color = number_as_color(fg_color);

            text = "";

            // put characters of the same color in one element
            while(i < text_mode_width
                    && text_mode_data[offset + 1] === bg_color
                    && text_mode_data[offset + 2] === fg_color)
            {
                var ascii = text_mode_data[offset];

                text += charmap[ascii];

                i++;
                offset += 3;

                if(row === cursor_row)
                {
                    if(i === cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === cursor_col + 1)
                    {
                        // found the cursor
                        fragment.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    };

    this.update_buffer = function(min, max)
    {
        if(max < min)
        {
            return;
        }

        var min_y = min / graphical_mode_width | 0;
        var max_y = max / graphical_mode_width | 0;

        graphic_context.putImageData(
            graphic_image_data,
            0, 0,
            0, min_y,
            graphical_mode_width, max_y - min_y + 1
        );
    };

    this.init();
}



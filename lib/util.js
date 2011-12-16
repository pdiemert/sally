var _ = require('underscore');

/****************************************
 * Nasty serialization of an object, differs from JSON in two ways:
 *
 * 1)  Functions are serialized
 * 2)  Dates are serialized to new Date() constructors
 *
 * Totally non-standard but allows code shipping and efficient date handling
 */
function packJS(o)
    {
        var s = '';

        if (_.isDate(o))
            {
                s += 'new Date(' + JSON.stringify(o) + ')';
            } else if (_.isArray(o))
            {
                s += '[';
                for (var i = 0; i < o.length; i++)
                    {
                        if (i > 0)
                            s += ',';
                        s += packJS(o[i]);
                    }
                s += ']';
            } else if (_.isFunction(o))
            {
                s += o.toString();
            } else if (_.isObject(o))
            {
                var inner = '';

                for (var prop in o)
                    {
                        if (inner.length > 0)
                            inner += ',';
                        inner += '\"' + prop + '\"' + ':' + packJS(o[prop]);
                    }

                s += '{' + inner + '}';
            }
        else
            s += JSON.stringify(o);

        return s;
    }

function unpackJS(s)
    {
        var o;

        eval('o = (' + s + ');');

        return o;
    }

exports.packJS = packJS;
exports.unpackJS = unpackJS;

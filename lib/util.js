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
    }
    else if (_.isArray(o))
    {
        s += '[';
        for (var i = 0; i < o.length; i++)
        {
            if (i > 0) s += ',';
            s += packJS(o[i]);
        }
        s += ']';
    }
    else if (_.isFunction(o))
    {
        s += o.toString();
    }
    else if (_.isObject(o))
    {
        var inner = '';

        for (var prop in o)
        {
            if (inner.length > 0) inner += ',';
            inner += '\"' + prop + '\"' + ':' + packJS(o[prop]);
        }

        s += '{' + inner + '}';
    }
    else s += JSON.stringify(o);

    return s;
}

function unpackJS(s)
{
    var o;

    eval('o = (' + s + ');');

    return o;
}


// Given a total count, divide it into a number of whole item partitions, each as equal as possible
// Return an array:
// [0] = the item index of the start item in the set. (offset)
// [1] = the number of items in partition specified by the index. (count)


function partition(totalCount, partitionCount, partitionIndex)
{
    var pop = 0;

    var part = ~~ (totalCount / partitionCount);
    pop = part;

    var rem = totalCount % partitionCount;

    if (partitionIndex < rem) pop++;

    var base = (part * partitionIndex) + Math.min(rem, partitionIndex);

    return [base, pop];
}



exports.packJS = packJS;
exports.unpackJS = unpackJS;
exports.partition = partition;
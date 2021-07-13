/**
 * Copyright (C) 2021 Thomas Weber
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License version 3
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @fileoverview Runtime for scripts generated by jsgen
 */

/* eslint-disable no-unused-vars */
/* eslint-disable prefer-template */
/* eslint-disable valid-jsdoc */

const globalState = {
    Timer: require('../util/timer'),
    Cast: require('../util/cast'),
    log: require('../util/log'),
    compatibilityLayerBlockUtility: require('./compat-block-utility'),
    thread: null
};

let baseRuntime = '';
const runtimeFunctions = {};

/**
 * Determine whether the current tick is likely stuck.
 * This implements similar functionality to the warp timer found in Scratch.
 * @returns {boolean} true if the current tick is likely stuck.
 */
runtimeFunctions.isStuck = `let stuckCounter = 0;
const isStuck = () => {
    // The real time is not checked on every call for performance.
    stuckCounter++;
    if (stuckCounter === 100) {
        stuckCounter = 0;
        return globalState.thread.target.runtime.sequencer.timer.timeElapsed() > 500;
    }
    return false;
}`;

/**
 * Start hats by opcode.
 * @param {string} requestedHat The opcode of the hat to start.
 * @param {*} optMatchFields Fields to match.
 * @returns {Array} A list of threads that were started.
 */
runtimeFunctions.startHats = `const startHats = (requestedHat, optMatchFields) => {
    const thread = globalState.thread;
    const threads = thread.target.runtime.startHats(requestedHat, optMatchFields);
    return threads;
}`;

/**
 * Implements "thread waiting", where scripts are halted until all the scripts have finished executing.
 * @param {Array} threads The list of threads.
 */
runtimeFunctions.waitThreads = `const waitThreads = function*(threads) {
    const thread = globalState.thread;
    const runtime = thread.target.runtime;

    while (true) {
        // determine whether any threads are running
        let anyRunning = false;
        for (let i = 0; i < threads.length; i++) {
            if (runtime.threads.indexOf(threads[i]) !== -1) {
                anyRunning = true;
                break;
            }
        }
        if (!anyRunning) {
            // all threads are finished, can resume
            return;
        }

        let allWaiting = true;
        for (let i = 0; i < threads.length; i++) {
            if (!runtime.isWaitingThread(threads[i])) {
                allWaiting = false;
                break;
            }
        }
        if (allWaiting) {
            thread.status = 3; // STATUS_YIELD_TICK
        }

        yield;
    }
}`;

/**
 * Wait until a Promise resolves or rejects before continuing.
 * @param {Promise} promise The promise to wait for.
 * @returns {*} the value that the promise resolves to, otherwise undefined if the promise rejects
 */

/**
 * Execute a scratch-vm primitive.
 * @param {*} inputs The inputs to pass to the block.
 * @param {function} blockFunction The primitive's function.
 * @param {boolean} useFlags Whether to set flags (hasResumedFromPromise)
 * @returns {*} the value returned by the block, if any.
 */
runtimeFunctions.executeInCompatibilityLayer = `let hasResumedFromPromise = false;
const waitPromise = function*(promise) {
    const thread = globalState.thread;
    let returnValue;

    promise
        .then(value => {
            returnValue = value;
            thread.status = 0; // STATUS_RUNNING
        })
        .catch(error => {
            thread.status = 0; // STATUS_RUNNING
            globalState.log.warn('Promise rejected in compiled script:', error);
        });

    // enter STATUS_PROMISE_WAIT and yield
    // this will stop script execution until the promise handlers reset the thread status
    thread.status = 1; // STATUS_PROMISE_WAIT
    yield;

    return returnValue;
};
const executeInCompatibilityLayer = function*(inputs, blockFunction, useFlags) {
    const thread = globalState.thread;

    // reset the stackframe
    // we only ever use one stackframe at a time, so this shouldn't cause issues
    thread.stackFrames[thread.stackFrames.length - 1].reuse(thread.warp > 0);

    const executeBlock = () => {
        const compatibilityLayerBlockUtility = globalState.compatibilityLayerBlockUtility;
        compatibilityLayerBlockUtility.thread = thread;
        compatibilityLayerBlockUtility.sequencer = thread.target.runtime.sequencer;
        return blockFunction(inputs, compatibilityLayerBlockUtility);
    };

    const isPromise = value => (
        // see engine/execute.js
        value !== null &&
        typeof value === 'object' &&
        typeof value.then === 'function'
    );

    let returnValue = executeBlock();

    if (isPromise(returnValue)) {
        returnValue = yield* waitPromise(returnValue);
        if (useFlags) {
            hasResumedFromPromise = true;
        }
        return returnValue;
    }

    while (thread.status === 2 /* STATUS_YIELD */ || thread.status === 3 /* STATUS_YIELD_TICK */) {
        // Yielded threads will run next iteration.
        if (thread.status === 2 /* STATUS_YIELD */) {
            thread.status = 0; // STATUS_RUNNING
            // Yield back to the event loop when stuck or not in warp mode.
            if (thread.warp === 0 || isStuck()) {
                yield;
            }
        } else {
            // status is STATUS_YIELD_TICK, always yield to the event loop
            yield;
        }

        returnValue = executeBlock();

        if (isPromise(returnValue)) {
            returnValue = yield* waitPromise(returnValue);
            if (useFlags) {
                hasResumedFromPromise = true;
            }
            return returnValue;
        }
    }

    // todo: do we have to do anything extra if status is STATUS_DONE?

    return returnValue;
}`;

/**
 * Run an addon block.
 * @param {string} procedureCode The block's procedure code
 * @param {string} blockId The ID of the block being run
 * @param {object} args The arguments to pass to the block
 */
runtimeFunctions.callAddonBlock = `const callAddonBlock = function*(procedureCode, blockId, args) {
    const thread = globalState.thread;
    const addonBlock = thread.target.runtime.getAddonBlock(procedureCode);
    if (addonBlock) {
        const target = thread.target;
        addonBlock.callback(args, {
            // Shim enough of BlockUtility to make addons work
            peekStack () {
                return blockId;
            },
            target
        });
        if (thread.status === 1 /* STATUS_PROMISE_WAIT */) {
            yield;
        }
    }
}`;

/**
 * End the current script.
 */
runtimeFunctions.retire = `const retire = () => {
    const thread = globalState.thread;
    thread.target.runtime.sequencer.retireThread(thread);
}`;

/**
 * Scratch cast to boolean.
 * Similar to Cast.toBoolean()
 * @param {*} value The value to cast
 * @returns {boolean} The value cast to a boolean
 */
runtimeFunctions.toBoolean = `const toBoolean = value => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        if (value === '' || value === '0' || value.toLowerCase() === 'false') {
            return false;
        }
        return true;
    }
    return !!value;
}`;

/**
 * Check if a value is considered whitespace.
 * Similar to Cast.isWhiteSpace()
 * @param {*} val Value to check
 * @returns {boolean} true if the value is whitespace
 */
baseRuntime += `
const isWhiteSpace = val => (
    val === null || (typeof val === 'string' && val.trim().length === 0)
);`;

/**
 * Determine if two values are equal.
 * @param {*} v1 First value
 * @param {*} v2 Second value
 * @returns {boolean} true if v1 is equal to v2
 */
baseRuntime += `
const compareEqual = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 === s2;
    }
    return n1 === n2;
};`;

/**
 * Determine if one value is greater than another.
 * @param {*} v1 First value
 * @param {*} v2 Second value
 * @returns {boolean} true if v1 is greater than v2
 */
runtimeFunctions.compareGreaterThan = `const compareGreaterThan = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 > s2;
    }
    return n1 > n2;
}`;

/**
 * Determine if one value is less than another.
 * @param {*} v1 First value
 * @param {*} v2 Second value
 * @returns {boolean} true if v1 is less than v2
 */
runtimeFunctions.compareLessThan = `const compareLessThan = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 < s2;
    }
    return n1 < n2;
}`;

/**
 * Generate a random integer.
 * @param {number} low Lower bound
 * @param {number} high Upper bound
 * @returns {number} A random integer between low and high, inclusive.
 */
runtimeFunctions.randomInt = `const randomInt = (low, high) => low + Math.floor(Math.random() * ((high + 1) - low))`;

/**
 * Generate a random float.
 * @param {number} low Lower bound
 * @param {number} high Upper bound
 * @returns {number} A random floating point number between low and high.
 */
runtimeFunctions.randomFloat = `const randomFloat = (low, high) => (Math.random() * (high - low)) + low`;

/**
 * Create and start a timer.
 * @returns {Timer} A started timer
 */
runtimeFunctions.timer = `const timer = () => {
    const t = new globalState.Timer({
        now: () => globalState.thread.target.runtime.currentMSecs
    });
    t.start();
    return t;
}`;

/**
 * Returns the amount of days since January 1st, 2000.
 * @returns {number} Days since 2000.
 */
// Date.UTC(2000, 0, 1) === 946684800000
// Hardcoding it is marginally faster
runtimeFunctions.daysSince2000 = `const daysSince2000 = () => (Date.now() - 946684800000) / (24 * 60 * 60 * 1000)`;

/**
 * Determine distance to a sprite or point.
 * @param {string} menu The name of the sprite or location to find.
 * @returns {number} Distance to the point, or 10000 if it cannot be calculated.
 */
runtimeFunctions.distance = `const distance = menu => {
    const thread = globalState.thread;
    if (thread.target.isStage) return 10000;

    let targetX = 0;
    let targetY = 0;
    if (menu === '_mouse_') {
        targetX = thread.target.runtime.ioDevices.mouse.getScratchX();
        targetY = thread.target.runtime.ioDevices.mouse.getScratchY();
    } else {
        const distTarget = thread.target.runtime.getSpriteTargetByName(menu);
        if (!distTarget) return 10000;
        targetX = distTarget.x;
        targetY = distTarget.y;
    }

    const dx = thread.target.x - targetX;
    const dy = thread.target.y - targetY;
    return Math.sqrt((dx * dx) + (dy * dy));
}`;

/**
 * Convert a Scratch list index to a JavaScript list index.
 * "all" is not considered as a list index.
 * Similar to Cast.toListIndex()
 * @param {number} index Scratch list index.
 * @param {number} length Length of the list.
 * @returns {number} 0 based list index, or -1 if invalid.
 */
baseRuntime += `
const listIndex = (index, length) => {
    if (typeof index !== 'number') {
        if (index === 'last') {
            if (length > 0) {
                return length - 1;
            }
            return -1;
        } else if (index === 'random' || index === '*') {
            if (length > 0) {
                return (Math.random() * length) | 0;
            }
            return -1;
        }
        index = +index || 0;
    }
    index = index | 0;
    if (index < 1 || index > length) {
        return -1;
    }
    return index - 1;
};`;

/**
 * Get a value from a list.
 * @param {Array} list The list
 * @param {*} idx The 1-indexed index in the list.
 * @returns {*} The list item, otherwise empty string if it does not exist.
 */
runtimeFunctions.listGet = `const listGet = (list, idx) => {
    const index = listIndex(idx, list.length);
    if (index === -1) {
        return '';
    }
    return list[index];
}`;

/**
 * Replace a value in a list.
 * @param {import('../engine/variable')} list The list
 * @param {*} idx List index, Scratch style.
 * @param {*} value The new value.
 */
runtimeFunctions.listReplace = `const listReplace = (list, idx, value) => {
    const index = listIndex(idx, list.value.length);
    if (index === -1) {
        return;
    }
    list.value[index] = value;
    list._monitorUpToDate = false;
}`;

/**
 * Insert a value in a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} idx The Scratch index in the list.
 * @param {*} value The value to insert.
 */
runtimeFunctions.listInsert = `const listInsert = (list, idx, value) => {
    const index = listIndex(idx, list.value.length + 1);
    if (index === -1) {
        return;
    }
    list.value.splice(index, 0, value);
    list._monitorUpToDate = false;
}`;

/**
 * Delete a value from a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} idx The Scratch index in the list.
 */
runtimeFunctions.listDelete = `const listDelete = (list, idx) => {
    if (idx === 'all') {
        list.value = [];
        return;
    }
    const index = listIndex(idx, list.value.length);
    if (index === -1) {
        return;
    }
    list.value.splice(index, 1);
    list._monitorUpToDate = false;
}`;

/**
 * Return whether a list contains a value.
 * @param {import('../engine/variable')} list The list.
 * @param {*} item The value to search for.
 * @returns {boolean} True if the list contains the item
 */
runtimeFunctions.listContains = `const listContains = (list, item) => {
    // TODO: evaluate whether indexOf is worthwhile here
    if (list.value.indexOf(item) !== -1) {
        return true;
    }
    for (let i = 0; i < list.value.length; i++) {
        if (compareEqual(list.value[i], item)) {
            return true;
        }
    }
    return false;
}`;

/**
 * Find the 1-indexed index of an item in a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} item The item to search for
 * @returns {number} The 1-indexed index of the item in the list, otherwise 0
 */
runtimeFunctions.listIndexOf = `const listIndexOf = (list, item) => {
    for (let i = 0; i < list.value.length; i++) {
        if (compareEqual(list.value[i], item)) {
            return i + 1;
        }
    }
    return 0;
}`;

/**
 * Get the stringified form of a list.
 * @param {import('../engine/variable')} list The list.
 * @returns {string} Stringified form of the list.
 */
runtimeFunctions.listContents = `const listContents = list => {
    for (let i = 0; i < list.value.length; i++) {
        const listItem = list.value[i];
        // this is an intentional break from what scratch 3 does to address our automatic string -> number conversions
        // it fixes more than it breaks
        if ((listItem + '').length !== 1) {
            return list.value.join(' ');
        }
    }
    return list.value.join('');
}`;

/**
 * Convert a color to an RGB list
 * @param {*} color The color value to convert
 * @return {Array.<number>} [r,g,b], values between 0-255.
 */
runtimeFunctions.colorToList = `const colorToList = color => globalState.Cast.toRgbColorList(color)`;

/**
 * Implements Scratch modulo (floored division instead of truncated division)
 * @param {number} n Number
 * @param {number} modulus Base
 * @returns {number} n % modulus (floored division)
 */
runtimeFunctions.mod = `const mod = (n, modulus) => {
    let result = n % modulus;
    if (result / modulus < 0) result += modulus;
    return result;
}`;

/**
 * Step a compiled thread.
 * @param {Thread} thread The thread to step.
 */
const execute = thread => {
    globalState.thread = thread;
    thread.generator.next();
};

const insertRuntime = source => {
    let result = baseRuntime;
    for (const functionName of Object.keys(runtimeFunctions)) {
        if (source.includes(functionName)) {
            result += `${runtimeFunctions[functionName]};`;
        }
    }
    result += `return ${source}`;
    return result;
};

/**
 * Evaluate arbitrary JS in the context of the runtime.
 * @param {string} source The string to evaluate.
 * @returns {*} The result of evaluating the string.
 */
const scopedEval = source => {
    try {
        const withRuntime = insertRuntime(source);
        return new Function('globalState', withRuntime)(globalState);
    } catch (e) {
        globalState.log.error('was unable to compile script', source);
        throw e;
    }
};

execute.scopedEval = scopedEval;

module.exports = execute;

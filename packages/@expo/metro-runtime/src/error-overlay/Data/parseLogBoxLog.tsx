/**
 * Copyright (c) 650 Industries.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from 'react';
import type { LogBoxLogData } from './LogBoxLog';
import { parseErrorStack } from '../devServerEndpoints';
type ExceptionData = any;

const BABEL_TRANSFORM_ERROR_FORMAT =
  /^(?:TransformError )?(?:SyntaxError: |ReferenceError: )(.*): (.*) \((\d+):(\d+)\)\n\n([\s\S]+)/;
const BABEL_CODE_FRAME_ERROR_FORMAT =
  /^(?:TransformError )?(?:.*):? (?:.*?)([/|\\].*): ([\s\S]+?)\n([ >]{2}[\d\s]+ \|[\s\S]+|\u{001b}[\s\S]+)/u;
const METRO_ERROR_FORMAT =
  /^(?:InternalError Metro has encountered an error:) (.*): (.*) \((\d+):(\d+)\)\n\n([\s\S]+)/u;

export type ExtendedExceptionData = ExceptionData & {
  isComponentError: boolean;
  [key: string]: any;
};
export type Category = string;
export type CodeFrame = {
  content: string;
  location?: {
    row: number;
    column: number;
    [key: string]: any;
  } | null;
  fileName: string;

  // TODO: When React switched to using call stack frames,
  // we gained the ability to use the collapse flag, but
  // it is not integrated into the LogBox UI.
  collapse?: boolean;
};

export type Message = {
  content: string;
  substitutions: {
    length: number;
    offset: number;
  }[];
};

export type ComponentStack = CodeFrame[];

const SUBSTITUTION = '\ufeff%s';

// TODO: Get rid of this. The substitution logic is wild.
export function parseInterpolation(args: readonly any[]): {
  category: Category;
  message: Message;
} {
  const categoryParts: string[] = [];
  const contentParts: string[] = [];
  const substitutionOffsets: { length: number; offset: number }[] = [];

  const remaining = [...args];
  if (typeof remaining[0] === 'string') {
    const formatString = String(remaining.shift());
    const formatStringParts = formatString.split('%s');
    const substitutionCount = formatStringParts.length - 1;
    const substitutions = remaining.splice(0, substitutionCount);

    let categoryString = '';
    let contentString = '';

    let substitutionIndex = 0;
    for (const formatStringPart of formatStringParts) {
      categoryString += formatStringPart;
      contentString += formatStringPart;

      if (substitutionIndex < substitutionCount) {
        if (substitutionIndex < substitutions.length) {
          // Don't stringify a string type.
          // It adds quotation mark wrappers around the string,
          // which causes the LogBox to look odd.
          const substitution =
            typeof substitutions[substitutionIndex] === 'string'
              ? substitutions[substitutionIndex]
              : stringifySafe(substitutions[substitutionIndex]);
          substitutionOffsets.push({
            length: substitution.length,
            offset: contentString.length,
          });

          categoryString += SUBSTITUTION;
          contentString += substitution;
        } else {
          substitutionOffsets.push({
            length: 2,
            offset: contentString.length,
          });

          categoryString += '%s';
          contentString += '%s';
        }

        substitutionIndex++;
      }
    }

    categoryParts.push(categoryString);
    contentParts.push(contentString);
  }

  const remainingArgs = remaining.map((arg) => {
    // Don't stringify a string type.
    // It adds quotation mark wrappers around the string,
    // which causes the LogBox to look odd.
    return typeof arg === 'string' ? arg : stringifySafe(arg);
  });
  categoryParts.push(...remainingArgs);
  contentParts.push(...remainingArgs);

  return {
    category: categoryParts.join(' '),
    message: {
      content: contentParts.join(' '),
      substitutions: substitutionOffsets,
    },
  };
}

export function hasComponentStack(args: any[]): boolean {
  for (const arg of args) {
    if (typeof arg === 'string' && isComponentStack(arg)) {
      return true;
    }
  }
  return false;
}

function isComponentStack(consoleArgument: string) {
  const isOldComponentStackFormat = / {4}in/.test(consoleArgument);
  const isNewComponentStackFormat = / {4}at/.test(consoleArgument);
  const isNewJSCComponentStackFormat = /@.*\n/.test(consoleArgument);

  return isOldComponentStackFormat || isNewComponentStackFormat || isNewJSCComponentStackFormat;
}

// TODO: Why are we returning a code frame?
function parseComponentStack(message: string): ComponentStack {
  return parseErrorStack(message)?.map((frame) => ({
    content: frame.methodName,
    collapse: frame.collapse || false,
    fileName: frame.file == null ? 'unknown' : frame.file,
    location: {
      column: frame.column == null ? -1 : frame.column,
      row: frame.lineNumber == null ? -1 : frame.lineNumber,
    },
  }));
}

export function parseLogBoxException(error: ExtendedExceptionData): LogBoxLogData {
  const message = error.originalMessage != null ? error.originalMessage : 'Unknown';

  const metroInternalError = message.match(METRO_ERROR_FORMAT);
  if (metroInternalError) {
    const [content, fileName, row, column, codeFrame] = metroInternalError.slice(1);

    return {
      level: 'fatal',
      type: 'Metro Error',
      stack: [],
      isComponentError: false,
      componentStack: [],
      codeFrame: {
        fileName,
        location: {
          row: parseInt(row, 10),
          column: parseInt(column, 10),
        },
        content: codeFrame,
      },
      message: {
        content,
        substitutions: [],
      },
      category: `${fileName}-${row}-${column}`,
    };
  }

  const babelTransformError = message.match(BABEL_TRANSFORM_ERROR_FORMAT);
  if (babelTransformError) {
    // Transform errors are thrown from inside the Babel transformer.
    const [fileName, content, row, column, codeFrame] = babelTransformError.slice(1);

    return {
      level: 'syntax',
      stack: [],
      isComponentError: false,
      componentStack: [],
      codeFrame: {
        fileName,
        location: {
          row: parseInt(row, 10),
          column: parseInt(column, 10),
        },
        content: codeFrame,
      },
      message: {
        content,
        substitutions: [],
      },
      category: `${fileName}-${row}-${column}`,
    };
  }

  const babelCodeFrameError = message.match(BABEL_CODE_FRAME_ERROR_FORMAT);

  if (babelCodeFrameError) {
    // Codeframe errors are thrown from any use of buildCodeFrameError.
    const [fileName, content, codeFrame] = babelCodeFrameError.slice(1);
    return {
      level: 'syntax',
      stack: [],
      isComponentError: false,
      componentStack: [],
      codeFrame: {
        fileName,
        location: null, // We are not given the location.
        content: codeFrame,
      },
      message: {
        content,
        substitutions: [],
      },
      category: `${fileName}-${1}-${1}`,
    };
  }

  if (message.match(/^TransformError /)) {
    return {
      level: 'syntax',
      stack: error.stack,
      isComponentError: error.isComponentError,
      componentStack: [],
      message: {
        content: message,
        substitutions: [],
      },
      category: message,
    };
  }

  const componentStack = error.componentStack;
  if (error.isFatal || error.isComponentError) {
    return {
      level: 'fatal',
      stack: error.stack,
      isComponentError: error.isComponentError,
      componentStack: componentStack != null ? parseComponentStack(componentStack) : [],
      ...parseInterpolation([message]),
    };
  }

  if (componentStack != null) {
    // It is possible that console errors have a componentStack.
    return {
      level: 'error',
      stack: error.stack,
      isComponentError: error.isComponentError,
      componentStack: parseComponentStack(componentStack),
      ...parseInterpolation([message]),
    };
  }

  // Most `console.error` calls won't have a componentStack. We parse them like
  // regular logs which have the component stack burried in the message.
  return {
    level: 'error',
    stack: error.stack,
    isComponentError: error.isComponentError,
    ...parseLogBoxLog([message]),
  };
}

function interpolateLikeConsole(...args: any[]) {
  let output = '';

  if (typeof args[0] === 'string') {
    const format = args[0];
    const rest = args.slice(1);
    let argIndex = 0;

    // TODO: %c for colors
    output = format.replace(/%[sdifoO%]/g, (match) => {
      if (match === '%%') return '%'; // escape %%
      const arg = rest[argIndex++];
      switch (match) {
        case '%s':
          return String(arg);
        case '%d':
        case '%i':
          return parseInt(arg, 10).toString();
        case '%f':
          return parseFloat(arg).toString();
        case '%o':
        case '%O':
          return stringifySafe(arg);
        default:
          return match;
      }
    });

    // Append any remaining arguments
    for (; argIndex < rest.length; argIndex++) {
      const arg = rest[argIndex];
      output +=
        ' ' +
        (typeof arg === 'object'
          ? arg instanceof Error
            ? arg.stack || arg.toString()
            : JSON.stringify(arg, null, 2)
          : String(arg));
    }
  } else {
    // No format string, just join args with spaces
    output = args.map((arg) => stringifySafe(arg)).join(' ');
  }

  return output;
}

const ERROR_TAG_SYMBOL = Symbol.for('expo.error.tagged');

export function hasTaggedError(error: any) {
  return error != null && error[ERROR_TAG_SYMBOL] === true;
}

export function tagError(error: any) {
  if (isError(error)) {
    //@ts-ignore
    error[ERROR_TAG_SYMBOL] = true;
  }
  return error;
}
export function isError(err: any): err is Error {
  return typeof err === 'object' && err !== null && 'name' in err && 'message' in err;
}
const REACT_STACK_BOTTOM_MARKER = 'react-stack-bottom-marker';
const REACT_STACK_BOTTOM_MARKER_REGEX = new RegExp(
  `(at ${REACT_STACK_BOTTOM_MARKER} )|(${REACT_STACK_BOTTOM_MARKER}\\@)`
);
/**
 * Extracts and processes React error details from the provided input error.
 * This function ensures that the error stack is cleaned up and includes only relevant frames.
 * It also appends the owner stack if available and tags the error for identification.
 *
 * @param inputError - The error object or any other type to process.
 * @returns A new Error object with updated stack and properties, or the original input if not an error.
 */
function processReactErrorDetails<T = unknown>(inputError: T): Error | T {
  const isInputErrorInstance = isError(inputError);

  // Tag the input error if it's an instance of Error.
  tagError(isInputErrorInstance);

  // Extract the original stack and message from the error.
  const originalStack = isInputErrorInstance ? inputError.stack || '' : '';
  const originalMessage = isInputErrorInstance ? inputError.message : '';

  // Split the stack into lines for processing.
  const stackLinesArray = originalStack.split('\n');

  // Find the index of the React stack bottom marker in the stack trace.
  const splitIndex = stackLinesArray.findIndex((line) =>
    REACT_STACK_BOTTOM_MARKER_REGEX.test(line)
  );

  // Determine if the stack contains the React stack bottom marker.
  const hasReactStackMarker = splitIndex >= 0;

  // Update the stack to exclude frames after the React stack bottom marker.
  const updatedStack = hasReactStackMarker
    ? stackLinesArray.slice(0, splitIndex).join('\n')
    : originalStack;

  // Create a new Error object with the updated stack and message.
  const updatedError = new Error(originalMessage);

  // Copy all enumerable properties from the input error to the new error.
  Object.assign(updatedError, inputError);

  // Set the updated stack on the new error.
  updatedError.stack = updatedStack;

  // Append the owner stack if available.
  appendOwnerStack(updatedError);

  // Tag the updated error for identification.
  tagError(updatedError);

  return updatedError;
}

/**
 * Appends the React owner stack to the provided error's stack trace.
 * This ensures that the error stack includes additional context about the React component hierarchy.
 *
 * @param error - The error object to update.
 */
function appendOwnerStack(error: Error) {
  // Check if React's captureOwnerStack function is available. React +19.1
  if (!React.captureOwnerStack) {
    return;
  }

  // Get the current stack and the owner stack.
  let stack = error.stack || '';
  const ownerStack = React.captureOwnerStack();

  // Avoid appending duplicate owner stack frames.
  if (ownerStack && !stack.endsWith(ownerStack)) {
    stack += ownerStack;

    // Override the stack with the updated value.
    error.stack = stack;
  }
}

export function parseLogBoxLog(args: any[]): {
  componentStack: ComponentStack;
  category: Category;
  message: Message;
} {
  const message = args[0];
  let argsWithoutComponentStack: any[] = [];
  let componentStack: ComponentStack = [];

  // Handle React 19 errors which have a custom format, come through console.error, and include a raw error object.
  if (React.captureOwnerStack != null) {
    // See https://github.com/facebook/react/blob/d50323eb845c5fde0d720cae888bf35dedd05506/packages/react-reconciler/src/ReactFiberErrorLogger.js#L78
    let error: Error | undefined;
    for (const arg of args) {
      if (isError(arg)) {
        error = arg;
        break;
      }
    }
    const message = interpolateLikeConsole(...args);
    if (!isError(error)) {
      error = new Error(message);
    }
    // Use the official stack from componentDidCatch
    if ('componentStack' in error) {
      // @ts-expect-error
      error.stack = error.componentStack;
    } else {
      error = processReactErrorDetails(error);
    }
    const componentStackTrace = (error as any).stack;
    return {
      componentStack: parseComponentStack(componentStackTrace),
      category: error.message,
      message: {
        content: message,
        substitutions: [],
      },
    };
  }

  // Extract component stack from warnings like "Some warning%s".
  if (typeof message === 'string' && message.slice(-2) === '%s' && args.length > 0) {
    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'string' && isComponentStack(lastArg)) {
      argsWithoutComponentStack = args.slice(0, -1);
      argsWithoutComponentStack[0] = message.slice(0, -2);
      componentStack = parseComponentStack(lastArg);
    }
  }

  if (componentStack.length === 0) {
    // Try finding the component stack elsewhere.
    for (const arg of args) {
      if (typeof arg === 'string' && isComponentStack(arg)) {
        // Strip out any messages before the component stack.
        let messageEndIndex = arg.search(/\n {4}(in|at) /);
        if (messageEndIndex < 0) {
          // Handle JSC component stacks.
          messageEndIndex = arg.search(/\n/);
        }
        if (messageEndIndex > 0) {
          argsWithoutComponentStack.push(arg.slice(0, messageEndIndex));
        }

        componentStack = parseComponentStack(arg);
      } else {
        argsWithoutComponentStack.push(arg);
      }
    }
  }

  return {
    ...parseInterpolation(argsWithoutComponentStack),
    componentStack,
  };
}

/**
 * Tries to stringify with JSON.stringify and toString, but catches exceptions
 * (e.g. from circular objects) and always returns a string and never throws.
 */
function createStringifySafeWithLimits(limits: {
  maxDepth?: number;
  maxStringLimit?: number;
  maxArrayLimit?: number;
  maxObjectKeysLimit?: number;
}): (foo: any) => string {
  const {
    maxDepth = Number.POSITIVE_INFINITY,
    maxStringLimit = Number.POSITIVE_INFINITY,
    maxArrayLimit = Number.POSITIVE_INFINITY,
    maxObjectKeysLimit = Number.POSITIVE_INFINITY,
  } = limits;
  const stack: any[] = [];
  function replacer(this: unknown, _key: string, value: any): any {
    while (stack.length && this !== stack[0]) {
      stack.shift();
    }

    if (typeof value === 'string') {
      const truncatedString = '...(truncated)...';
      if (value.length > maxStringLimit + truncatedString.length) {
        return value.substring(0, maxStringLimit) + truncatedString;
      }
      return value;
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    let retval = value;
    if (Array.isArray(value)) {
      if (stack.length >= maxDepth) {
        retval = `[ ... array with ${value.length} values ... ]`;
      } else if (value.length > maxArrayLimit) {
        retval = value
          .slice(0, maxArrayLimit)
          .concat([`... extra ${value.length - maxArrayLimit} values truncated ...`]);
      }
    } else {
      // Add refinement after Array.isArray call.
      if (typeof value !== 'object') {
        throw new Error('This was already found earlier');
      }
      const keys = Object.keys(value);
      if (stack.length >= maxDepth) {
        retval = `{ ... object with ${keys.length} keys ... }`;
      } else if (keys.length > maxObjectKeysLimit) {
        // Return a sample of the keys.
        retval = {};
        for (const k of keys.slice(0, maxObjectKeysLimit)) {
          retval[k] = value[k];
        }
        const truncatedKey = '...(truncated keys)...';
        retval[truncatedKey] = keys.length - maxObjectKeysLimit;
      }
    }
    stack.unshift(retval);
    return retval;
  }

  return function stringifySafe(arg: any): string {
    if (arg === undefined) {
      return 'undefined';
    } else if (arg === null) {
      return 'null';
    } else if (typeof arg === 'function') {
      try {
        return arg.toString();
      } catch {
        return '[function unknown]';
      }
    } else if (arg instanceof Error) {
      return arg.message;
      // return arg.name + ': ' + arg.message;
    } else {
      // Perform a try catch, just in case the object has a circular
      // reference or stringify throws for some other reason.
      try {
        const ret = JSON.stringify(arg, replacer);
        if (ret === undefined) {
          return '["' + typeof arg + '" failed to stringify]';
        }
        return ret;
      } catch {
        if (typeof arg.toString === 'function') {
          try {
            // $FlowFixMe[incompatible-use] : toString shouldn't take any arguments in general.
            return arg.toString();
          } catch {}
        }
      }
    }
    return '["' + typeof arg + '" failed to stringify]';
  };
}

const stringifySafe = createStringifySafeWithLimits({
  maxDepth: 10,
  maxStringLimit: 100,
  maxArrayLimit: 50,
  maxObjectKeysLimit: 50,
});

import type { IgnorePattern, LogData } from './Data/LogBoxData';
import { type ExtendedExceptionData } from './Data/parseLogBoxLog';
import * as LogBoxData from './Data/LogBoxData';

export { LogData, ExtendedExceptionData, IgnorePattern };

/**
 * LogBox displays logs in the app.
 */
import { parseLogBoxLog } from './Data/parseLogBoxLog';

let originalConsoleError: typeof console.error | undefined;
let consoleErrorImpl: typeof console.error | undefined;

let isLogBoxInstalled: boolean = false;

const LogBox = {
  install(): void {
    if (isLogBoxInstalled) {
      return;
    }

    isLogBoxInstalled = true;

    // Trigger lazy initialization of module.
    // require("../NativeModules/specs/NativeLogBox");

    // IMPORTANT: we only overwrite `console.error` and `console.warn` once.
    // When we uninstall we keep the same reference and only change its
    // internal implementation
    const isFirstInstall = originalConsoleError == null;
    if (isFirstInstall) {
      originalConsoleError = console.error.bind(console);

      console.error = (...args) => {
        consoleErrorImpl?.(...args);
      };
    }

    consoleErrorImpl = registerError;

    if (process.env.NODE_ENV === 'test') {
      LogBoxData.setDisabled(true);
    }
  },

  uninstall(): void {
    if (!isLogBoxInstalled) {
      return;
    }

    isLogBoxInstalled = false;

    // IMPORTANT: we don't re-assign to `console` in case the method has been
    // decorated again after installing LogBox. E.g.:
    // Before uninstalling: original > LogBox > OtherErrorHandler
    // After uninstalling:  original > LogBox (noop) > OtherErrorHandler
    consoleErrorImpl = originalConsoleError;
    delete (console as any).disableLogBox;
  },

  isInstalled(): boolean {
    return isLogBoxInstalled;
  },

  ignoreLogs(patterns: IgnorePattern[]): void {
    LogBoxData.addIgnorePatterns(patterns);
  },

  ignoreAllLogs(value?: boolean): void {
    LogBoxData.setDisabled(value == null ? true : value);
  },

  clearAllLogs(): void {
    LogBoxData.clear();
  },

  addLog(log: LogData): void {
    if (isLogBoxInstalled) {
      LogBoxData.addLog(log);
    }
  },

  addException(error: ExtendedExceptionData): void {
    if (isLogBoxInstalled) {
      LogBoxData.addException(error);
    }
  },
};

// @ts-ignore
const isWarningModuleWarning = (...args: any) => {
  if (typeof args[0] !== 'string') {
    return false;
  }

  // console.log('LogBox: ', Object.entries(args));
  return / {4}at/.test(args[0]) || /^Warning:\s/.test(args[0]);
};

const registerError = (...args: Parameters<typeof console.error>): void => {
  // Let errors within LogBox itself fall through.
  if (LogBoxData.isLogBoxErrorMessage(args[0])) {
    originalConsoleError?.(...args);
    return;
  }

  try {
    // if (!isWarningModuleWarning(...args)) {
    //   // Only show LogBox for the 'warning' module, otherwise pass through.
    //   // By passing through, this will get picked up by the React console override,
    //   // potentially adding the component stack. React then passes it back to the
    //   // React Native ExceptionsManager, which reports it to LogBox as an error.
    //   //
    //   // The 'warning' module needs to be handled here because React internally calls
    //   // `console.error('Warning: ')` with the component stack already included.
    //   originalConsoleError?.(...args);
    //   return;
    // }

    const { category, message, componentStack } = parseLogBoxLog(args);

    if (!LogBoxData.isMessageIgnored(message.content)) {
      // NOTE: Unlike React Native, we'll just pass the logs directly to the console
      originalConsoleError?.(...args);
      // Interpolate the message so they are formatted for adb and other CLIs.
      // This is different than the message.content above because it includes component stacks.
      // const interpolated = parseInterpolation(args);
      // originalConsoleError?.(interpolated.message.content);

      LogBoxData.addLog({
        // Always show the static rendering issues as full screen since they
        // are too confusing otherwise.
        level: /did not match\. Server:/.test(message.content) ? 'fatal' : 'error',
        category,
        message,
        componentStack,
      });
    }
  } catch (unexpectedError: any) {
    LogBoxData.reportUnexpectedLogBoxError(unexpectedError);
  }
};

export default LogBox;

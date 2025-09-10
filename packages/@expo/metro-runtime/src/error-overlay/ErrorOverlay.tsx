/**
 * Copyright (c) 650 Industries.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import React, { useCallback, useEffect, useState } from 'react';

import * as LogBoxData from './Data/LogBoxData';
import { LogBoxLog, type LogLevel, type StackType } from './Data/LogBoxLog';
import { useLogs } from './Data/LogContext';
import { ErrorOverlayHeader } from './overlay/ErrorOverlayHeader';
import { ErrorCodeFrame } from './overlay/ErrorCodeFrame';
import { StackTraceList } from './overlay/StackTraceList';

import type { Message } from './Data/parseLogBoxLog';
import { LogBoxMessage } from './LogBoxMessage';
//@ts-expect-error
import styles from './ErrorOverlay.module.css';
import ReactDOM from 'react-dom/client';
import { fetchProjectMetadataAsync, getFormattedStackTrace } from './devServerEndpoints';

const HEADER_TITLE_MAP = {
  warn: 'Console Warning',
  error: 'Console Error',
  fatal: 'Uncaught Error',
  syntax: 'Build Error',
  static: 'Server Error',
  component: 'Render Error',
};

export function LogBoxInspectorContainer() {
  const { selectedLogIndex, logs } = useLogs();
  const log = logs[selectedLogIndex];
  if (log == null) {
    return null;
  }
  return <LogBoxInspector log={log} selectedLogIndex={selectedLogIndex} logs={logs} />;
}

function useDevServerMeta() {
  const [meta, setMeta] = useState<{
    projectRoot: string;
    serverRoot: string;
    sdkVersion: string;
  } | null>(null);
  useEffect(() => {
    fetchProjectMetadataAsync()
      .then(setMeta)
      .catch((error) => {
        console.log(
          `Failed to fetch project metadata. Some debugging features may not work as expected: ${error}`
        );
      });
  }, []);

  return meta;
}

export function LogBoxInspector({
  log,
  selectedLogIndex,
  logs,
}: {
  log: LogBoxLog;
  selectedLogIndex: number;
  logs: LogBoxLog[];
}) {
  const meta = useDevServerMeta();
  const isDismissable = !['static', 'syntax'].includes(log.level);
  const [closing, setClosing] = useState(false);

  // TODO: Get this outside of the bundle.
  const projectRoot = meta?.projectRoot;

  const animateClosed = (callback: () => void) => {
    setClosing(true);
    setTimeout(() => {
      callback();
    }, 200);
  };

  const onDismiss = (): void => {
    // Here we handle the cases when the log is dismissed and it
    // was either the last log, or when the current index
    // is now outside the bounds of the log array.
    const logsArray = Array.from(logs);
    if (selectedLogIndex != null) {
      if (logsArray.length - 1 <= 0) {
        animateClosed(() => {
          LogBoxData.setSelectedLog(-1);
        });
      } else if (selectedLogIndex >= logsArray.length - 1) {
        LogBoxData.setSelectedLog(selectedLogIndex - 1);
      }

      if (logs.length === 1) {
        animateClosed(() => {
          LogBoxData.dismiss(logsArray[selectedLogIndex]);
        });
      } else {
        LogBoxData.dismiss(logsArray[selectedLogIndex]);
      }
    }
  };

  const onMinimize = useCallback((): void => {
    animateClosed(() => {
      LogBoxData.setSelectedLog(-1);
    });
  }, []);

  const onChangeSelectedIndex = useCallback((index: number): void => {
    LogBoxData.setSelectedLog(index);
  }, []);

  useEffect(() => {
    if (log) {
      LogBoxData.symbolicateLogNow('stack', log);
      LogBoxData.symbolicateLogNow('component', log);
    }
  }, [log]);

  useEffect(() => {
    // Optimistically symbolicate the last and next logs.
    if (logs.length > 1) {
      const selected = selectedLogIndex;
      const lastIndex = logs.length - 1;
      const prevIndex = selected - 1 < 0 ? lastIndex : selected - 1;
      const nextIndex = selected + 1 > lastIndex ? 0 : selected + 1;
      for (const type of ['component', 'stack'] as const) {
        LogBoxData.symbolicateLogLazy(type, logs[prevIndex]);
        LogBoxData.symbolicateLogLazy(type, logs[nextIndex]);
      }
    }
  }, [logs, selectedLogIndex]);

  const _handleRetry = useCallback(
    (type: StackType) => {
      LogBoxData.retrySymbolicateLogNow(type, log);
    },
    [log]
  );

  const onCopy = () => {
    // Copy log to clipboard
    const errContents = [log.message.content.trim()];

    const componentStack = log.getAvailableStack('component');
    if (componentStack?.length) {
      errContents.push(
        '',
        'Component Stack',
        getFormattedStackTrace(projectRoot ?? '', componentStack)
      );
    }
    const stackTrace = log.getAvailableStack('stack');

    if (stackTrace?.length) {
      errContents.push('', 'Call Stack', getFormattedStackTrace(projectRoot ?? '', stackTrace));
    }

    navigator.clipboard.writeText(errContents.join('\n'));
  };

  return (
    <>
      <div className={styles.overlay}>
        <div
          data-expo-log-backdrop="true"
          className={`${styles.bg} ${closing ? styles.bgExit : ''}`}
          onClick={() => {
            if (isDismissable) {
              onMinimize();
            }
          }}
        />
        <div className={`${styles.container} ${closing ? styles.containerExit : ''}`}>
          <div
            style={{
              position: 'sticky',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 1,
              backgroundColor: 'var(--expo-log-color-background)',
            }}>
            <ErrorOverlayHeader
              sdkVersion={meta?.sdkVersion}
              selectedIndex={selectedLogIndex}
              total={logs.length}
              isDismissable={isDismissable}
              onDismiss={onDismiss}
              onMinimize={onMinimize}
              onSelectIndex={onChangeSelectedIndex}
              level={log.level}
              onCopy={onCopy}
            />
          </div>
          <ErrorOverlayBody message={log.message} level={log.level} type={log.type}>
            <ErrorCodeFrame projectRoot={projectRoot} codeFrame={log.codeFrame} />

            {!!log?.componentStack?.length && (
              <StackTraceList
                type="component"
                projectRoot={projectRoot}
                stack={log.getAvailableStack('component')}
                symbolicationStatus={log.symbolicated['component'].status}
                // eslint-disable-next-line react/jsx-no-bind
                onRetry={_handleRetry.bind(_handleRetry, 'component')}
              />
            )}
            <StackTraceList
              type="stack"
              projectRoot={projectRoot}
              stack={log.getAvailableStack('stack')}
              symbolicationStatus={log.symbolicated['stack'].status}
              // eslint-disable-next-line react/jsx-no-bind
              onRetry={_handleRetry.bind(_handleRetry, 'stack')}
            />
          </ErrorOverlayBody>
          {!isDismissable && (
            <ErrorOverlayFooter message="Build-time errors can only be dismissed by fixing the issue." />
          )}
        </div>
      </div>
    </>
  );
}

function ErrorOverlayFooter({ message }: { message?: string }) {
  return (
    <div className={styles.footer}>
      <footer
        style={{
          padding: '1rem',
          flex: 1,
          backgroundColor: 'var(--expo-log-secondary-system-background)',
          borderTop: `1px solid var(--expo-log-color-border)`,
        }}>
        <span
          style={{
            color: 'var(--expo-log-secondary-label)',
            fontSize: '0.875rem',
            fontFamily: 'var(--expo-log-font-family)',
          }}>
          {message}
        </span>
      </footer>
    </div>
  );
}

function ErrorOverlayBody({
  message,
  level,
  type,
  isComponentError,
  children,
}: {
  type: LogBoxLog['type'];
  message: LogBoxLog['message'];
  level: LogBoxLog['level'];
  isComponentError?: boolean;
  children?: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);

  const headerTitle = HEADER_TITLE_MAP[isComponentError ? 'component' : level] ?? type;

  return (
    <>
      <ErrorMessageHeader
        collapsed={collapsed}
        onPress={() => setCollapsed(!collapsed)}
        message={message}
        level={level}
        title={headerTitle}
      />

      <div style={{ padding: '0 1rem', gap: 10, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </>
  );
}

const SHOW_MORE_MESSAGE_LENGTH = 300;

export function ErrorMessageHeader(props: {
  collapsed: boolean;
  message: Message;
  level: LogLevel;
  title: string;
  onPress: () => void;
}) {
  return (
    <div
      style={{
        padding: '0 1rem',
        display: 'flex',
        gap: 8,
        flexDirection: 'column',
      }}>
      <div style={{ display: 'flex' }}>
        <span
          data-testid="logbox_title"
          style={{
            fontFamily: 'var(--expo-log-font-family)',
            padding: 8,
            backgroundColor:
              props.level === 'warn' ? 'rgba(243, 250, 154, 0.2)' : 'rgba(205, 97, 94, 0.2)',
            borderRadius: 8,
            fontWeight: '600',
            fontSize: 14,
            color:
              props.level === 'warn' ? 'rgba(243, 250, 154, 1)' : `var(--expo-log-color-danger)`,
          }}>
          {props.title}
        </span>
      </div>
      <span
        style={{
          color: 'var(--expo-log-color-label)',
          fontFamily: 'var(--expo-log-font-family)',
          fontSize: 16,
          whiteSpace: 'pre-wrap',
          fontWeight: '500',
        }}>
        <LogBoxMessage
          maxLength={props.collapsed ? SHOW_MORE_MESSAGE_LENGTH : Infinity}
          message={props.message}
        />
        <ShowMoreButton {...props} />
      </span>
    </div>
  );
}

function ShowMoreButton({
  message,
  collapsed,
  onPress,
}: {
  collapsed: boolean;
  message: Message;
  onPress: () => void;
}) {
  if (message.content.length < SHOW_MORE_MESSAGE_LENGTH || !collapsed) {
    return null;
  }
  return (
    <button
      style={{
        color: 'var(--expo-log-color-label)',
        fontFamily: 'var(--expo-log-font-family)',
        backgroundColor: 'transparent',
        cursor: 'pointer',
        border: 'none',
        opacity: 0.7,
        fontSize: 14,
      }}
      onClick={onPress}>
      ... See more
    </button>
  );
}

let currentRoot: ReactDOM.Root | null = null;

export function presentGlobalErrorOverlay() {
  if (currentRoot) {
    return;
  }
  const ErrorOverlay = LogBoxData.withSubscription(LogBoxInspectorContainer);

  // Create a new div with ID `error-overlay` element and render LogBoxInspector into it.
  const div = document.createElement('div');
  div.id = 'error-overlay';
  document.body.appendChild(div);

  currentRoot = ReactDOM.createRoot(div);
  currentRoot.render(React.createElement(ErrorOverlay));
}

export function dismissGlobalErrorOverlay() {
  // Remove div with ID `error-overlay`
  if (currentRoot) {
    currentRoot.unmount();
    currentRoot = null;
  }
  const div = document.getElementById('error-overlay');
  div?.remove();
}

/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { ExpoConfig, Platform } from '@expo/config';
import chalk from 'chalk';
import fs from 'fs';
import Bundler from 'metro/src/Bundler';
import { ConfigT } from 'metro-config';
import { Resolution, ResolutionContext, CustomResolutionContext } from 'metro-resolver';
import * as metroResolver from 'metro-resolver';
import path from 'path';
import resolveFrom from 'resolve-from';

import { createFallbackModuleResolver } from './createExpoFallbackResolver';
import { createFastResolver, FailedToResolvePathError } from './createExpoMetroResolver';
import {
  createStickyModuleResolverInput,
  createStickyModuleResolver,
  StickyModuleResolverInput,
} from './createExpoStickyResolver';
import { isNodeExternal, shouldCreateVirtualCanary, shouldCreateVirtualShim } from './externals';
import { isFailedToResolveNameError, isFailedToResolvePathError } from './metroErrors';
import { getMetroBundlerWithVirtualModules } from './metroVirtualModules';
import {
  withMetroErrorReportingResolver,
  withMetroMutatedResolverContext,
  withMetroResolvers,
} from './withMetroResolvers';
import { Log } from '../../../log';
import { FileNotifier } from '../../../utils/FileNotifier';
import { env } from '../../../utils/env';
import { CommandError } from '../../../utils/errors';
import { installExitHooks } from '../../../utils/exit';
import { isInteractive } from '../../../utils/interactive';
import { loadTsConfigPathsAsync, TsConfigPaths } from '../../../utils/tsconfig/loadTsConfigPaths';
import { resolveWithTsConfigPaths } from '../../../utils/tsconfig/resolveWithTsConfigPaths';
import { isServerEnvironment } from '../middleware/metroOptions';
import { PlatformBundlers } from '../platformBundlers';
import { memoize } from '../../../utils/fn';
import { toPosixPath } from '../../../utils/filePath';
import { findClosestPackageJson } from './createJResolver';
import { getMetroServerRoot } from '@expo/config/paths';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type StrictResolver = (moduleName: string) => Resolution;
export type StrictResolverFactory = (
  context: ResolutionContext,
  platform: string | null
) => StrictResolver;

const ASSET_REGISTRY_SRC = `const assets=[];module.exports={registerAsset:s=>assets.push(s),getAssetByID:s=>assets[s-1]};`;

const debug = require('debug')('expo:start:server:metro:multi-platform') as typeof console.log;

function withWebPolyfills(
  config: ConfigT,
  {
    getMetroBundler,
  }: {
    getMetroBundler: () => Bundler;
  }
): ConfigT {
  

  const originalGetPolyfills = config.serializer.getPolyfills
    ? config.serializer.getPolyfills.bind(config.serializer)
    : () => [];

  const getPolyfills = (ctx: { platform?: string | null }): readonly string[] => {
    const virtualEnvVarId = `\0polyfill:environment-variables`;

    getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
      virtualEnvVarId,
      (() => {
        return `//`;
      })()
    );

    const virtualModuleId = `\0polyfill:external-require`;

    getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
      virtualModuleId,
      (() => {
        if (ctx.platform === 'web') {
          return `global.$$require_external = typeof require !== "undefined" ? require : () => null;`;
        } else {
          // Wrap in try/catch to support Android.
          return 'try { global.$$require_external = typeof expo === "undefined" ? require : (moduleId) => { throw new Error(`Node.js standard library module ${moduleId} is not available in this JavaScript environment`);} } catch { global.$$require_external = (moduleId) => { throw new Error(`Node.js standard library module ${moduleId} is not available in this JavaScript environment`);} }';
        }
      })()
    );

    if (ctx.platform === 'web') {
      return [
        virtualModuleId,
        virtualEnvVarId,
        // Ensure that the error-guard polyfill is included in the web polyfills to
        // make metro-runtime work correctly.
        // TODO: This module is pretty big for a function that simply re-throws an error that doesn't need to be caught.
        require.resolve('@react-native/js-polyfills/error-guard'),
      ];
    }
    // Generally uses `rn-get-polyfills`
    const polyfills = originalGetPolyfills(ctx);

    // Move all polyfills to the native built-in bundle.
    if (env.EXPO_BUNDLE_BUILT_IN) {
      return [
        ...polyfills
      ]
    }

    return [
      // ...polyfills,
      virtualModuleId,
      virtualEnvVarId,

      // This built-in is still required for server bundles.
      // TODO: Prevent this from being included in the native client bundle.
      require.resolve('@react-native/js-polyfills/error-guard'),
      // Removed on server platforms during the transform.
      // TODO: Move to be a native built-in.
      // require.resolve('expo/virtual/streams.js'),
    ];
  };

  return {
    ...config,
    serializer: {
      ...config.serializer,
      getPolyfills,
    },
  };
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, '/');
}

function createBuiltinModuleIdFactory(
  root: string
  // resolver: (moduleName: string, platform: string | null) => Resolution
): (path: string, context?: { platform: string; environment?: string }) => number {
  if (!env.EXPO_BUNDLE_BUILT_IN) {
    throw new Error('custom module ID factory only used for builtins');
  }
  const MAPPING = {
    'node_modules/react/index.js': 'react',
    'node_modules/react/jsx-runtime.js': 'react/jsx-runtime',
    'node_modules/url/url.js': 'url',
    'node_modules/whatwg-fetch/dist/fetch.umd.js': 'whatwg-fetch',
    'node_modules/react-devtools-core/dist/backend.js': 'react-devtools-core',
    'node_modules/whatwg-url-without-unicode/index.js': 'whatwg-url-without-unicode',
    'node_modules/buffer/index.js': 'buffer',
    'node_modules/punycode/punycode.js': 'punycode',
    'node_modules/base64-js/index.js': 'base64-js',
    'node_modules/ieee754/index.js': 'ieee754',
    'node_modules/pretty-format/build/index.js': 'pretty-format',
    'node_modules/event-target-shim/dist/event-target-shim.mjs': 'event-target-shim',
    'node_modules/invariant/browser.js': 'invariant',
    'node_modules/regenerator-runtime/runtime.js': 'regenerator-runtime/runtime',
    'node_modules/react-refresh/runtime.js': 'react-refresh/runtime',
    'node_modules/react-native/Libraries/ReactNative/RendererProxy.js':
      'react-native/Libraries/ReactNative/RendererProxy',
    'node_modules/react/jsx-dev-runtime.js': 'react/jsx-dev-runtime',
    'node_modules/@react-native/normalize-colors/index.js': '@react-native/normalize-colors',
    'node_modules/anser/lib/index.js': 'anser',
    'node_modules/react-native/src/private/setup/setUpDOM.js':
      'react-native/src/private/setup/setUpDOM',
    'node_modules/scheduler/index.native.js': 'scheduler',

    ///
    'node_modules/react-native/index.js': 'react-native',
    'node_modules/react-native/Libraries/Core/InitializeCore.js':
      'react-native/Libraries/Core/InitializeCore',
    'node_modules/react-native/src/private/featureflags/ReactNativeFeatureFlags.js':
      'react-native/src/private/featureflags/ReactNativeFeatureFlags',
    'node_modules/react-native/Libraries/NativeComponent/NativeComponentRegistry.js':
      'react-native/Libraries/NativeComponent/NativeComponentRegistry',
    'node_modules/react-native/Libraries/Utilities/PolyfillFunctions.js':
      'react-native/Libraries/Utilities/PolyfillFunctions',
    'node_modules/react-native/Libraries/ReactPrivate/ReactNativePrivateInterface.js':
      'react-native/Libraries/ReactPrivate/ReactNativePrivateInterface',
    'node_modules/react-native/Libraries/Image/resolveAssetSource.js':
      'react-native/Libraries/Image/resolveAssetSource',
    'node_modules/react-native/Libraries/StyleSheet/processColor.js':
      'react-native/Libraries/StyleSheet/processColor',
    'node_modules/react-native/Libraries/NativeComponent/ViewConfigIgnore.js':
      'react-native/Libraries/NativeComponent/ViewConfigIgnore',
    'node_modules/react-native/Libraries/StyleSheet/processColorArray.js':
      'react-native/Libraries/StyleSheet/processColorArray',
    'node_modules/react-native/Libraries/NativeModules/specs/NativeSourceCode.js':
      'react-native/Libraries/NativeModules/specs/NativeSourceCode',
    'node_modules/react-native/Libraries/Image/AssetSourceResolver.js':
      'react-native/Libraries/Image/AssetSourceResolver',
    'node_modules/react-native/Libraries/ReactPrivate/ReactNativePrivateInitializeCore.js':
      'react-native/Libraries/ReactPrivate/ReactNativePrivateInitializeCore',
    'node_modules/react-native/Libraries/Utilities/HMRClient.js':
      'react-native/Libraries/Utilities/HMRClient',
    
      'node_modules/react-native/Libraries/Core/Devtools/getDevServer.js':
      'react-native/Libraries/Core/Devtools/getDevServer',
      'node_modules/react-native/Libraries/WebSocket/WebSocket.js':
      'react-native/Libraries/WebSocket/WebSocket',
      'node_modules/react-native/Libraries/NativeModules/specs/NativeLogBox.js': 'react-native/Libraries/NativeModules/specs/NativeLogBox',
      'node_modules/react-native/Libraries/Core/ExceptionsManager.js': 'react-native/Libraries/Core/ExceptionsManager',
      'node_modules/react-native/Libraries/Network/RCTNetworking.ios.js': 'react-native/Libraries/Network/RCTNetworking',

      'node_modules/react-native/Libraries/Core/Devtools/symbolicateStackTrace.js': 'react-native/Libraries/Core/Devtools/symbolicateStackTrace',
      'node_modules/react-native/Libraries/Components/View/ReactNativeStyleAttributes.js': 'react-native/Libraries/Components/View/ReactNativeStyleAttributes',


      'node_modules/metro-runtime/src/modules/HMRClient.js': 'metro-runtime/src/modules/HMRClient',


    //
    'packages/expo-modules-core/src/index.ts': 'expo-modules-core',
    'packages/expo-modules-core/src/LegacyEventEmitter.ts':
      'expo-modules-core/src/LegacyEventEmitter',

    'packages/expo/src/winter/index.ts': 'expo/src/winter',
    'packages/expo/src/Expo.ts': 'expo',
    'packages/expo/dom/global.js': 'expo/dom/global',
    'packages/expo/dom/index.js': 'expo/dom',
    'packages/expo-asset/build/index.js': 'expo-asset',
    'packages/expo-constants/build/Constants.js': 'expo-constants',
    'packages/expo-keep-awake/build/index.js': 'expo-keep-awake',
    'packages/expo-status-bar/src/StatusBar.tsx': 'expo-status-bar',
    // 'node_modules/@react-native/virtualized-lists/index.js': '@react-native/virtualized-lists',
    // base64-js

"packages/expo-linking/build/Linking.js": "expo-linking",
"packages/expo-blur/build/index.js": "expo-blur",
"packages/expo-font/build/index.js": "expo-font",
"packages/expo-haptics/src/Haptics.ts": "expo-haptics",
"packages/expo-image/src/index.ts": "expo-image",
"packages/expo-splash-screen/build/index.native.js": "expo-splash-screen",
"packages/expo-symbols/build/index.js": "expo-symbols",
"packages/expo-system-ui/build/SystemUI.js": "expo-system-ui",
 "packages/expo-web-browser/build/WebBrowser.js": "expo-web-browser",
"node_modules/react-native-gesture-handler/src/index.ts": "react-native-gesture-handler",
"node_modules/react-native-reanimated/src/index.ts": "react-native-reanimated",
"node_modules/react-native-is-edge-to-edge/dist/index.mjs": "react-native-is-edge-to-edge",
"node_modules/react-native-safe-area-context/src/index.tsx": "react-native-safe-area-context",
"node_modules/react-native-screens/src/index.tsx": "react-native-screens",
"node_modules/react-freeze/src/index.tsx": "react-freeze",

"node_modules/warn-once/index.js": "warn-once",
"node_modules/escape-string-regexp/index.js": "escape-string-regexp",
"node_modules/react-native-webview/src/index.ts": 'react-native-webview',

"node_modules/@react-native-masked-view/masked-view/index.js": '@react-native-masked-view/masked-view',
// React Navigation
"node_modules/color/index.js": 'color',
"node_modules/color-string/index.js": 'color-string',
"node_modules/color-convert/index.js": 'color-convert',

"node_modules/@radix-ui/react-compose-refs/dist/index.js": "@radix-ui/react-compose-refs",
"node_modules/nanoid/non-secure/index.js": 'nanoid/non-secure',
"node_modules/@react-navigation/routers/lib/module/index.js": '@react-navigation/routers',
"node_modules/use-latest-callback/esm.mjs": 'use-latest-callback',
"node_modules/query-string/index.js": 'query-string',
"node_modules/react-is/index.js": 'react-is',
"node_modules/use-sync-external-store/with-selector.js": 'use-sync-external-store/with-selector',
"node_modules/@react-navigation/core/lib/module/index.js": '@react-navigation/core',

"node_modules/@react-navigation/native/lib/module/index.js": '@react-navigation/native',
"node_modules/@react-navigation/elements/lib/module/index.js": '@react-navigation/elements',
"node_modules/@react-navigation/bottom-tabs/lib/module/index.js": '@react-navigation/bottom-tabs',
"node_modules/@radix-ui/react-slot/dist/index.mjs": "@radix-ui/react-slot",
"node_modules/@react-navigation/native-stack/lib/module/index.js": '@react-navigation/native-stack',
"node_modules/stacktrace-parser/dist/stack-trace-parser.cjs.js": 'stacktrace-parser',
  };

  function isVirtualModule(path: string) {
    return path.startsWith('\0');
  }

  // TODO: Replace all of this with some sort of built-in version of Node module resolution where we add the package.json to the bundle and perform a lookup inside of the native-require.
  // This will ensure we don't have to hard-code built-in entries and ensure fuzzy matching like `react/index.js` work.
  const getModulePath = (modulePath: string, platform: string) => {
    // NOTE: Metro allows this but it can lead to confusing errors when dynamic requires cannot be resolved, e.g. `module 456 cannot be found`.
    if (modulePath == null) {
      return 'MODULE_NOT_FOUND';
    } else if (isVirtualModule(modulePath)) {
      // Virtual modules should be stable.
      return modulePath;
    }

    const result = () => {
      const absPath = toPosixPath(
        path.isAbsolute(modulePath) ? modulePath : path.join(root, modulePath)
      );

      const relPath = toPosixPath(
        path.isAbsolute(modulePath) ? path.relative(root, modulePath) : modulePath
      );

      function findNearest(from: string) {
      const pkgPath = findClosestPackageJson(from, {
        isDirectory(p) {
          return !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();
        },
        pathExists(file) {
          return !!fs.existsSync(file);
        },
      });

      if (pkgPath) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

          if (pkg.name == null) {
            return findNearest(path.dirname(path.dirname(pkgPath)));
          }
          return [pkgPath, pkg];
      }
      return null;
    }

      const res = findNearest(absPath);

      if (res) {
        const [pkgPath, pkg] = res;
        // const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

        const pkgRoot = path.dirname(pkgPath);
        const relPathFromPkgRoot = path.relative(pkgRoot, absPath);
        console.log('|', relPath, pkg.name, relPathFromPkgRoot, pkgPath);

        // First, determine if the module conforms to the package.json default export, e.g. `node_modules/react/index.js` conforms to `react`.

        if (pkg.exports) {
          // TODO: ...
          // Find best package export for the module
        } else {
          // resolver({

          // }, pkg.name, platform)
          const mainField = pkg['react-native'] ?? pkg.module ?? pkg.main ?? 'index';

          // const fuzzyMain = path.join(pkgRoot, mainField);
          const fuzzyMainResolved = resolveFrom.silent(mainField, pkgRoot);

          if (fuzzyMainResolved === absPath) {
            // console.log('MATCH', modulePath, fuzzyMainResolved);
            return pkg.name;
          } else {
            // console.log('>>>>', fuzzyMainResolved);
            // console.log('EXT',);
          }

          // Resolve package main field.
        }
      }

      if (MAPPING[relPath]) {
        // If the module is in the mapping, return the mapped value.
        return MAPPING[relPath];
      }
      return relPath;
    };

    return 'native:' + result();
  };

  const memoizedGetModulePath = memoize(getModulePath);

  // This is an absolute file path.
  // TODO: We may want a hashed version for production builds in the future.
  return (modulePath: string, context?: { platform: string; environment?: string }): number => {
    // Helps find missing parts to the patch.
    if (!context?.platform) {
      // context = { platform: 'web' };
      throw new Error('createStableModuleIdFactory: `context.platform` is required');
    }

    return memoizedGetModulePath(modulePath, context.platform);
  };
}

export function getNodejsExtensions(srcExts: readonly string[]): string[] {
  const mjsExts = srcExts.filter((ext) => /mjs$/.test(ext));
  const nodejsSourceExtensions = srcExts.filter((ext) => !/mjs$/.test(ext));
  // find index of last `*.js` extension
  const jsIndex = nodejsSourceExtensions.reduce((index, ext, i) => {
    return /jsx?$/.test(ext) ? i : index;
  }, -1);

  // insert `*.mjs` extensions after `*.js` extensions
  nodejsSourceExtensions.splice(jsIndex + 1, 0, ...mjsExts);

  return nodejsSourceExtensions;
}

/**
 * Apply custom resolvers to do the following:
 * - Disable `.native.js` extensions on web.
 * - Alias `react-native` to `react-native-web` on web.
 * - Redirect `react-native-web/dist/modules/AssetRegistry/index.js` to `@react-native/assets/registry.js` on web.
 * - Add support for `tsconfig.json`/`jsconfig.json` aliases via `compilerOptions.paths`.
 * - Alias react-native renderer code to a vendored React canary build on native.
 */
export function withExtendedResolver(
  config: ConfigT,
  {
    tsconfig,
    stickyModuleResolverInput,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
    isReactServerComponentsEnabled,
    getMetroBundler,
  }: {
    tsconfig: TsConfigPaths | null;
    stickyModuleResolverInput?: StickyModuleResolverInput;
    isTsconfigPathsEnabled?: boolean;
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled?: boolean;
    isReactServerComponentsEnabled?: boolean;
    getMetroBundler: () => Bundler;
  }
) {
  if (isReactServerComponentsEnabled) {
    Log.warn(`React Server Components (beta) is enabled.`);
  }
  if (isReactCanaryEnabled) {
    Log.warn(`Experimental React 19 canary is enabled.`);
  }
  if (isFastResolverEnabled) {
    Log.log(chalk.dim`Fast resolver is enabled.`);
  }
  if (stickyModuleResolverInput) {
    Log.log(chalk.dim`Sticky resolver is enabled.`);
  }

  const defaultResolver = metroResolver.resolve;
  const resolver = isFastResolverEnabled
    ? createFastResolver({
        preserveSymlinks: true,
        blockList: !config.resolver?.blockList
          ? []
          : Array.isArray(config.resolver?.blockList)
            ? config.resolver?.blockList
            : [config.resolver?.blockList],
      })
    : defaultResolver;

  const aliases: { [key: string]: Record<string, string> } = {
    web: {
      'react-native': 'react-native-web',
      'react-native/index': 'react-native-web',
      'react-native/Libraries/Image/resolveAssetSource': 'expo-asset/build/resolveAssetSource',
    },
  };

  // The vendored canary modules live inside /static/canary-full/node_modules
  // Adding the `index.js` allows us to add this path as `originModulePath` to
  // resolve the nested `node_modules` folder properly.
  const canaryModulesPath = path.join(
    require.resolve('@expo/cli/package.json'),
    '../static/canary-full/index.js'
  );

  let _universalAliases: [RegExp, string][] | null;

  function getUniversalAliases() {
    if (_universalAliases) {
      return _universalAliases;
    }

    _universalAliases = [];

    // This package is currently always installed as it is included in the `expo` package.
    if (resolveFrom.silent(config.projectRoot, '@expo/vector-icons')) {
      debug('Enabling alias: react-native-vector-icons -> @expo/vector-icons');
      _universalAliases.push([/^react-native-vector-icons(\/.*)?/, '@expo/vector-icons$1']);
    }
    if (isReactServerComponentsEnabled) {
      if (resolveFrom.silent(config.projectRoot, 'expo-router/rsc')) {
        debug('Enabling bridge alias: expo-router -> expo-router/rsc');
        _universalAliases.push([/^expo-router$/, 'expo-router/rsc']);
        // Bridge the internal entry point which is a standalone import to ensure package.json resolution works as expected.
        _universalAliases.push([/^expo-router\/entry-classic$/, 'expo-router/rsc/entry']);
      }
    }
    return _universalAliases;
  }

  const preferredMainFields: { [key: string]: string[] } = {
    // Defaults from Expo Webpack. Most packages using `react-native` don't support web
    // in the `react-native` field, so we should prefer the `browser` field.
    // https://github.com/expo/router/issues/37
    web: ['browser', 'module', 'main'],
  };

  let tsConfigResolve =
    isTsconfigPathsEnabled && (tsconfig?.paths || tsconfig?.baseUrl != null)
      ? resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
          paths: tsconfig.paths ?? {},
          baseUrl: tsconfig.baseUrl ?? config.projectRoot,
          hasBaseUrl: !!tsconfig.baseUrl,
        })
      : null;

  // TODO: Move this to be a transform key for invalidation.
  if (!isExporting && isInteractive()) {
    if (isTsconfigPathsEnabled) {
      // TODO: We should track all the files that used imports and invalidate them
      // currently the user will need to save all the files that use imports to
      // use the new aliases.
      const configWatcher = new FileNotifier(config.projectRoot, [
        './tsconfig.json',
        './jsconfig.json',
      ]);
      configWatcher.startObserving(() => {
        debug('Reloading tsconfig.json');
        loadTsConfigPathsAsync(config.projectRoot).then((tsConfigPaths) => {
          if (tsConfigPaths?.paths && !!Object.keys(tsConfigPaths.paths).length) {
            debug('Enabling tsconfig.json paths support');
            tsConfigResolve = resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
              paths: tsConfigPaths.paths ?? {},
              baseUrl: tsConfigPaths.baseUrl ?? config.projectRoot,
              hasBaseUrl: !!tsConfigPaths.baseUrl,
            });
          } else {
            debug('Disabling tsconfig.json paths support');
            tsConfigResolve = null;
          }
        });
      });

      // TODO: This probably prevents the process from exiting.
      installExitHooks(() => {
        configWatcher.stopObserving();
      });
    } else {
      debug('Skipping tsconfig.json paths support');
    }
  }

  let nodejsSourceExtensions: string[] | null = null;

  const getStrictResolver: StrictResolverFactory = (
    { resolveRequest, ...context },
    platform
  ): StrictResolver => {
    return function doResolve(moduleName: string): Resolution {
      return resolver(context, moduleName, platform);
    };
  };

  function getOptionalResolver(context: ResolutionContext, platform: string | null) {
    const doResolve = getStrictResolver(context, platform);
    return function optionalResolve(moduleName: string): Resolution | null {
      try {
        return doResolve(moduleName);
      } catch (error) {
        // If the error is directly related to a resolver not being able to resolve a module, then
        // we can ignore the error and try the next resolver. Otherwise, we should throw the error.
        const isResolutionError =
          isFailedToResolveNameError(error) || isFailedToResolvePathError(error);
        if (!isResolutionError) {
          throw error;
        }
      }
      return null;
    };
  }

  // TODO: This is a hack to get resolveWeak working.
  const idFactory = (config.serializer?.createModuleIdFactory?.() ??
    ((id: number | string, context: { platform: string; environment?: string }): number | string =>
      id)) as (
    id: number | string,
    context: { platform: string; environment?: string }
  ) => number | string;

  const getAssetRegistryModule = () => {
    const virtualModuleId = `\0polyfill:assets-registry`;
    getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
      virtualModuleId,
      ASSET_REGISTRY_SRC
    );
    return {
      type: 'sourceFile',
      filePath: virtualModuleId,
    } as const;
  };

  if (env.EXPO_BUNDLE_BUILT_IN) {
    config.serializer.createModuleIdFactory = createBuiltinModuleIdFactory.bind(
      null,
      getMetroServerRoot(config.projectRoot)
      // resolver.bind(null, {
      //   dev: true,
      //   allowHaste: false,
      //   assetExts: config.resolver.assetExts,
      //   mainFields: config.resolver.resolverMainFields,
      //   sourceExts: config.resolver.sourceExts,
      // })
    );
  }

  // If Node.js pass-through, then remap to a module like `module.exports = $$require_external(<module>)`.
  // If module should be shimmed, remap to an empty module.
  const externals: {
    match: (
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) => boolean | { name: string; match: boolean };

    replace: 'empty' | 'node' | 'weak' | 'builtin';
  }[] = [
    {
      match: (context: ResolutionContext, moduleName: string) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for Node.js environments.
          !isServerEnvironment(context.customResolverOptions?.environment)
        ) {
          return false;
        }

        if (context.customResolverOptions?.environment === 'react-server') {
          // Ensure these non-react-server modules are excluded when bundling for React Server Components in development.
          return /^(source-map-support(\/.*)?|@babel\/runtime\/.+|debug|metro-runtime\/src\/modules\/HMRClient|metro|acorn-loose|acorn|chalk|ws|ansi-styles|supports-color|color-convert|has-flag|utf-8-validate|color-name|react-refresh\/runtime|@remix-run\/node\/.+)$/.test(
            moduleName
          );
        }

        // TODO: Windows doesn't support externals somehow.
        if (process.platform === 'win32') {
          return /^(source-map-support(\/.*)?)$/.test(moduleName);
        }

        // Extern these modules in standard Node.js environments in development to prevent API routes side-effects
        // from leaking into the dev server process.
        return /^(source-map-support(\/.*)?|react|@radix-ui\/.+|@babel\/runtime\/.+|react-dom(\/.+)?|debug|acorn-loose|acorn|css-in-js-utils\/lib\/.+|hyphenate-style-name|color|color-string|color-convert|color-name|fontfaceobserver|fast-deep-equal|query-string|escape-string-regexp|invariant|postcss-value-parser|memoize-one|nullthrows|strict-uri-encode|decode-uri-component|split-on-first|filter-obj|warn-once|simple-swizzle|is-arrayish|inline-style-prefixer\/.+)$/.test(
          moduleName
        );
      },
      replace: 'node',
    },
    {
      match: (context: ResolutionContext, moduleName: string) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for Node.js environments.
          isServerEnvironment(context.customResolverOptions?.environment)
        ) {
          return false;
        }
        if (env.EXPO_BUNDLE_BUILT_IN) {
          return false;
        }

        let match =
          /^(native:)?(react-native-is-edge-to-edge|@react-navigation\/bottom-tabs|stacktrace-parser|@radix-ui\/react-slot|@react-navigation\/native-stack|@react-navigation\/elements|@react-navigation\/core|@react-navigation\/native|query-string|react-is|use-sync-external-store\/with-selector|use-latest-callback|@react-navigation\/routers|nanoid\/non-secure|@radix-ui\/react-compose-refs|@react-native-masked-view\/masked-view|color|color-convert|color-string|expo\/src\/winter|expo\/dom|expo\/dom\/global|warn-once|escape-string-regexp|metro-runtime\/src\/modules\/HMRClient|react-native-webview|react-native-screens|react-native-safe-area-context|react-native-reanimated|react-native-gesture-handler|expo-web-browser|expo-system-ui|expo-symbols|expo-splash-screen|expo-linking|expo-image|expo|expo-blur|expo-font|expo-haptics|expo-asset|expo-constants|expo-keep-awake|expo-status-bar|expo-modules-core|expo-modules-core\/src\/LegacyEventEmitter|react|url|whatwg-fetch|react-devtools-core|whatwg-url-without-unicode|buffer|punycode|base64-js|ieee754|pretty-format|event-target-shim|invariant|regenerator-runtime\/runtime|react-refresh\/runtime|react-native\/Libraries\/ReactNative\/RendererProxy|react\/jsx-runtime|react\/jsx-dev-runtime|@react-native\/normalize-colors|anser|react-native\/src\/private\/setup\/setUpDOM|scheduler)$/.test(
            moduleName
          );

// import "expo-blur"
// import "expo-font"
// import "expo-haptics"
// import "expo-image"
// import "expo-linking"
// import "expo-splash-screen"
// import "expo-symbols"
// import "expo-system-ui"
// import "expo-web-browser"

// import "react-native-gesture-handler"
// import "react-native-reanimated"
// import "react-native-safe-area-context"
// import "react-native-screens"
// import "react-native-webview"


        if (!match) {
          if (
            context.originModulePath.endsWith('InitializeCore.js') &&
            moduleName.startsWith('../../src/private/setup/setUpDOM')
          ) {
            match = true;
            return {
              name: 'react-native/src/private/setup/setUpDOM',
              match: true,
            };
          }
          // TODO: Match `(\/index(\.[tj]sx?)?)?` and strip the extras.




          // TODO: Account for .js extensions.
          match =
            /^(native:)?(react-native|react-native\/index|react-native\/Libraries\/Utilities\/HMRClient|react-native\/Libraries\/Core\/Devtools\/getDevServer|react-native\/Libraries\/WebSocket\/WebSocket|react-native\/Libraries\/NativeModules\/specs\/NativeLogBox|react-native\/Libraries\/Core\/ExceptionsManager|react-native\/Libraries\/Network\/RCTNetworking|react-native\/Libraries\/Core\/Devtools\/symbolicateStackTrace|react-native\/Libraries\/Components\/View\/ReactNativeStyleAttributes|react-native\/Libraries\/Core\/InitializeCore|react-native\/src\/private\/featureflags\/ReactNativeFeatureFlags|react-native\/Libraries\/NativeComponent\/NativeComponentRegistry|react-native\/Libraries\/Utilities\/PolyfillFunctions|react-native\/Libraries\/ReactPrivate\/ReactNativePrivateInterface|react-native\/Libraries\/Image\/resolveAssetSource|react-native\/Libraries\/StyleSheet\/processColor|react-native\/Libraries\/NativeComponent\/ViewConfigIgnore|react-native\/Libraries\/StyleSheet\/processColorArray|react-native\/Libraries\/NativeModules\/specs\/NativeSourceCode|react-native\/Libraries\/Image\/AssetSourceResolver|react-native\/Libraries\/ReactPrivate\/ReactNativePrivateInitializeCore)$/.test(
              moduleName
            );
          // else if (
          //   context.originModulePath.includes('/react-native/') &&
          //   moduleName.includes('/ReactNative/RendererProxy')
          // ) {
          //   match = true;
          //   return {
          //     name: 'react-native/Libraries/ReactNative/RendererProxy',
          //     match: true,
          //   };
          // }
        }

        if (!match && !moduleName.startsWith('.') && moduleName.includes('/')) {
          memoLog(moduleName);
        }
        return match;
      },
      replace: 'builtin',
    },
    // Externals to speed up async split chunks by extern-ing common packages that appear in the root client chunk.
    {
      match: (context: ResolutionContext, moduleName: string, platform: string | null) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for client environments.
          isServerEnvironment(context.customResolverOptions?.environment) ||
          // Only enable for client boundaries
          !context.customResolverOptions.clientboundary
        ) {
          return false;
        }

        // We don't support this in the resolver at the moment.
        if (moduleName.endsWith('/package.json')) {
          return false;
        }

        const isExternal = // Extern these modules in standard Node.js environments.
          /^(deprecated-react-native-prop-types|react|react\/jsx-dev-runtime|scheduler|react-native|react-dom(\/.+)?|metro-runtime(\/.+)?)$/.test(
            moduleName
          ) ||
          // TODO: Add more
          /^@babel\/runtime\/helpers\/(wrapNativeSuper)$/.test(moduleName);

        return isExternal;
      },
      replace: 'weak',
    },
  ];

  const memoLog = memoize(console.log);

  const metroConfigWithCustomResolver = withMetroResolvers(config, [
    // Mock out production react imports in development.
    function requestDevMockProdReact(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      // This resolution is dev-only to prevent bundling the production React packages in development.
      if (!context.dev || env.EXPO_BUNDLE_BUILT_IN) return null;

      if (
        // Match react-native renderers.
        (platform !== 'web' &&
          context.originModulePath.match(/[\\/]node_modules[\\/]react-native[\\/]/) &&
          moduleName.match(/([\\/]ReactFabric|ReactNativeRenderer)-prod/)) ||
        // Match react production imports.
        (moduleName.match(/\.production(\.min)?\.js$/) &&
          // Match if the import originated from a react package.
          context.originModulePath.match(/[\\/]node_modules[\\/](react[-\\/]|scheduler[\\/])/))
      ) {
        debug(`Skipping production module: ${moduleName}`);
        // /Users/path/to/expo/node_modules/react/index.js ./cjs/react.production.min.js
        // /Users/path/to/expo/node_modules/react/jsx-dev-runtime.js ./cjs/react-jsx-dev-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        // /Users/path/to/expo/node_modules/react-refresh/runtime.js ./cjs/react-refresh-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/scheduler/index.native.js ./cjs/scheduler.native.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        return {
          type: 'empty',
        };
      }
      return null;
    },
    // tsconfig paths
    function requestTsconfigPaths(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      return (
        tsConfigResolve?.(
          {
            originModulePath: context.originModulePath,
            moduleName,
          },
          getOptionalResolver(context, platform)
        ) ?? null
      );
    },

    // Node.js externals support
    function requestNodeExternals(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      const isServer =
        context.customResolverOptions?.environment === 'node' ||
        context.customResolverOptions?.environment === 'react-server';

      const moduleId = isNodeExternal(moduleName);
      if (!moduleId) {
        return null;
      }

      if (
        // In browser runtimes, we want to either resolve a local node module by the same name, or shim the module to
        // prevent crashing when Node.js built-ins are imported.
        !isServer
      ) {
        // Perform optional resolve first. If the module doesn't exist (no module in the node_modules)
        // then we can mock the file to use an empty module.
        const result = getOptionalResolver(context, platform)(moduleName);

        if (!result && platform !== 'web') {
          // Preserve previous behavior where native throws an error on node.js internals.
          return null;
        }

        return (
          result ?? {
            // In this case, mock the file to use an empty module.
            type: 'empty',
          }
        );
      }
      const contents = `module.exports=$$require_external('node:${moduleId}');`;
      debug(`Virtualizing Node.js "${moduleId}"`);
      const virtualModuleId = `\0node:${moduleId}`;
      getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
        virtualModuleId,
        contents
      );
      return {
        type: 'sourceFile',
        filePath: virtualModuleId,
      };
    },

    // Custom externals support
    function requestCustomExternals(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      // We don't support this in the resolver at the moment.
      if (moduleName.endsWith('/package.json')) {
        return null;
      }
      // Skip applying JS externals for CSS files.
      if (/\.(s?css|sass)$/.test(context.originModulePath)) {
        return null;
      }

      const environment = context.customResolverOptions?.environment;

      const strictResolve = getStrictResolver(context, platform);

      for (const external of externals) {
        const results = external.match(context, moduleName, platform);
        if (results) {
          const interopName = typeof results === 'object' ? results.name : moduleName;
          if (external.replace === 'empty') {
            debug(`Redirecting external "${moduleName}" to "${external.replace}"`);
            return {
              type: external.replace,
            };
          } else if (external.replace === 'weak') {
            // TODO: Make this use require.resolveWeak again. Previously this was just resolving to the same path.
            const realModule = strictResolve(moduleName);
            const realPath = realModule.type === 'sourceFile' ? realModule.filePath : moduleName;
            const opaqueId = idFactory(realPath, {
              platform: platform!,
              environment,
            });

            const contents =
              typeof opaqueId === 'number'
                ? `module.exports=/*${moduleName}*/__r(${opaqueId})`
                : `module.exports=/*${moduleName}*/__r(${JSON.stringify(opaqueId)})`;
            // const contents = `module.exports=/*${moduleName}*/__r(require.resolveWeak('${moduleName}'))`;
            // const generatedModuleId = fastHashMemoized(contents);
            const virtualModuleId = `\0weak:${opaqueId}`;
            debug('Virtualizing module:', moduleName, '->', virtualModuleId);
            getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
              virtualModuleId,
              contents
            );
            return {
              type: 'sourceFile',
              filePath: virtualModuleId,
            };
          } else if (external.replace === 'node') {
            const contents = `module.exports=$$require_external('${moduleName}')`;
            const virtualModuleId = `\0node:${moduleName}`;
            debug('Virtualizing Node.js (custom):', moduleName, '->', virtualModuleId);
            getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
              virtualModuleId,
              contents
            );
            return {
              type: 'sourceFile',
              filePath: virtualModuleId,
            };
          } else if (external.replace === 'builtin') {
            const contents = `module.exports=__native__r('native:${interopName.replace(/^native:/, '')}')`;
            const virtualModuleId = `\0native:${interopName}`;
            debug('Virtualizing Native built-in (custom):', interopName, '->', virtualModuleId);
            getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
              virtualModuleId,
              contents
            );
            return {
              type: 'sourceFile',
              filePath: virtualModuleId,
            };
          } else {
            throw new CommandError(
              `Invalid external alias type: "${external.replace}" for module "${moduleName}" (platform: ${platform}, originModulePath: ${context.originModulePath})`
            );
          }
        }
      }
      return null;
    },

    // Basic moduleId aliases
    function requestAlias(context: ResolutionContext, moduleName: string, platform: string | null) {
      // Conditionally remap `react-native` to `react-native-web` on web in
      // a way that doesn't require Babel to resolve the alias.
      if (platform && platform in aliases && aliases[platform][moduleName]) {
        const redirectedModuleName = aliases[platform][moduleName];
        return getStrictResolver(context, platform)(redirectedModuleName);
      }

      for (const [matcher, alias] of getUniversalAliases()) {
        const match = moduleName.match(matcher);
        if (match) {
          const aliasedModule = alias.replace(
            /\$(\d+)/g,
            (_, index) => match[parseInt(index, 10)] ?? ''
          );
          const doResolve = getStrictResolver(context, platform);
          debug(`Alias "${moduleName}" to "${aliasedModule}"`);
          return doResolve(aliasedModule);
        }
      }

      return null;
    },

    // Polyfill for asset registry
    function requestStableAssetRegistry(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      if (/^@react-native\/assets-registry\/registry(\.js)?$/.test(moduleName)) {
        return getAssetRegistryModule();
      }

      if (
        platform === 'web' &&
        context.originModulePath.match(/node_modules[\\/]react-native-web[\\/]/) &&
        moduleName.includes('/modules/AssetRegistry')
      ) {
        return getAssetRegistryModule();
      }

      return null;
    },

    createStickyModuleResolver(stickyModuleResolverInput, {
      getStrictResolver,
    }),

    // TODO: Reduce these as much as possible in the future.
    // Complex post-resolution rewrites.
    function requestPostRewrites(
      context: ResolutionContext,
      moduleName: string,
      platform: string | null
    ) {
      const doResolve = getStrictResolver(context, platform);

      const result = doResolve(moduleName);

      if (result.type !== 'sourceFile') {
        return result;
      }

      if (platform === 'web') {
        if (result.filePath.includes('node_modules')) {
          // // Disallow importing confusing native modules on web
          if (moduleName.includes('react-native/Libraries/Utilities/codegenNativeCommands')) {
            throw new FailedToResolvePathError(
              `Importing native-only module "${moduleName}" on web from: ${context.originModulePath}`
            );
          }

          // Replace with static shims

          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          const shimFile = shouldCreateVirtualShim(normalName);
          if (shimFile) {
            const virtualId = `\0shim:${normalName}`;
            const bundler = getMetroBundlerWithVirtualModules(getMetroBundler());
            if (!bundler.hasVirtualModule(virtualId)) {
              bundler.setVirtualModule(virtualId, fs.readFileSync(shimFile, 'utf8'));
            }
            debug(`Redirecting module "${result.filePath}" to shim`);

            return {
              ...result,
              filePath: virtualId,
            };
          }
        }
      } else {
        const isServer =
          context.customResolverOptions?.environment === 'node' ||
          context.customResolverOptions?.environment === 'react-server';

        // react-native/Libraries/Core/InitializeCore
        const normal = normalizeSlashes(result.filePath);

        // Shim out React Native native runtime globals in server mode for native.
        if (isServer) {
          if (normal.endsWith('react-native/Libraries/Core/InitializeCore.js')) {
            debug('Shimming out InitializeCore for React Native in native SSR bundle');
            return {
              type: 'empty',
            };
          }
        }

        // When server components are enabled, redirect React Native's renderer to the canary build
        // this will enable the use hook and other requisite features from React 19.
        if (isReactCanaryEnabled && result.filePath.includes('node_modules')) {
          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          const canaryFile = shouldCreateVirtualCanary(normalName);
          if (canaryFile) {
            debug(`Redirecting React Native module "${result.filePath}" to canary build`);
            return {
              ...result,
              filePath: canaryFile,
            };
          }
        }
      }

      return result;
    },

    // If at this point, we haven't resolved a module yet, if it's a module specifier for a known dependency
    // of either `expo` or `expo-router`, attempt to resolve it from these origin modules instead
    createFallbackModuleResolver({
      projectRoot: config.projectRoot,
      originModuleNames: ['expo', 'expo-router'],
      getStrictResolver,
    }),
  ]);

  // Ensure we mutate the resolution context to include the custom resolver options for server and web.
  const metroConfigWithCustomContext = withMetroMutatedResolverContext(
    metroConfigWithCustomResolver,
    (
      immutableContext: CustomResolutionContext,
      moduleName: string,
      platform: string | null
    ): CustomResolutionContext => {
      const context: Mutable<CustomResolutionContext> = {
        ...immutableContext,
        preferNativePlatform: platform !== 'web',
      };

      // TODO: Remove this when we have React 19 in the expo/expo monorepo.
      if (
        isReactCanaryEnabled &&
        // Change the node modules path for react and react-dom to use the vendor in Expo CLI.
        /^(react|react\/.*|react-dom|react-dom\/.*)$/.test(moduleName)
      ) {
        // Modifying the origin module path changes the starting Node module resolution path to this folder
        context.originModulePath = canaryModulesPath;
        // Hierarchical lookup has to be enabled for this to work
        context.disableHierarchicalLookup = false;
      }

      if (isServerEnvironment(context.customResolverOptions?.environment)) {
        // Adjust nodejs source extensions to sort mjs after js, including platform variants.
        if (nodejsSourceExtensions === null) {
          nodejsSourceExtensions = getNodejsExtensions(context.sourceExts);
        }
        context.sourceExts = nodejsSourceExtensions;

        context.unstable_enablePackageExports = true;
        context.unstable_conditionsByPlatform = {};

        const isReactServerComponents =
          context.customResolverOptions?.environment === 'react-server';

        if (isReactServerComponents) {
          // NOTE: Align the behavior across server and client. This is a breaking change so we'll just roll it out with React Server Components.
          // This ensures that react-server and client code both resolve `module` and `main` in the same order.
          if (platform === 'web') {
            // Node.js runtimes should only be importing main at the moment.
            // This is a temporary fix until we can support the package.json exports.
            context.mainFields = ['module', 'main'];
          } else {
            // In Node.js + native, use the standard main fields.
            context.mainFields = ['react-native', 'module', 'main'];
          }
        } else {
          if (platform === 'web') {
            // Node.js runtimes should only be importing main at the moment.
            // This is a temporary fix until we can support the package.json exports.
            context.mainFields = ['main', 'module'];
          } else {
            // In Node.js + native, use the standard main fields.
            context.mainFields = ['react-native', 'main', 'module'];
          }
        }

        // Enable react-server import conditions.
        if (context.customResolverOptions?.environment === 'react-server') {
          context.unstable_conditionNames = ['node', 'react-server', 'workerd'];
        } else {
          context.unstable_conditionNames = ['node'];
        }
      } else {
        // Non-server changes

        if (!env.EXPO_METRO_NO_MAIN_FIELD_OVERRIDE && platform && platform in preferredMainFields) {
          context.mainFields = preferredMainFields[platform];
        }
      }

      return context;
    }
  );

  return withMetroErrorReportingResolver(metroConfigWithCustomContext);
}

/** @returns `true` if the incoming resolution should be swapped. */
export function shouldAliasModule(
  input: {
    platform: string | null;
    result: Resolution;
  },
  alias: { platform: string; output: string }
): boolean {
  return (
    input.platform === alias.platform &&
    input.result?.type === 'sourceFile' &&
    typeof input.result?.filePath === 'string' &&
    normalizeSlashes(input.result.filePath).endsWith(alias.output)
  );
}

/** Add support for `react-native-web` and the Web platform. */
export async function withMetroMultiPlatformAsync(
  projectRoot: string,
  {
    config,
    exp,
    platformBundlers,
    isTsconfigPathsEnabled,
    isStickyResolverEnabled,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
    isNamedRequiresEnabled,
    isReactServerComponentsEnabled,
    getMetroBundler,
  }: {
    config: ConfigT;
    exp: ExpoConfig;
    isTsconfigPathsEnabled: boolean;
    platformBundlers: PlatformBundlers;
    isStickyResolverEnabled?: boolean;
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled: boolean;
    isReactServerComponentsEnabled: boolean;
    isNamedRequiresEnabled: boolean;
    getMetroBundler: () => Bundler;
  }
) {
  if (isNamedRequiresEnabled) {
    debug('Using Expo metro require runtime.');
    // Change the default metro-runtime to a custom one that supports bundle splitting.
    require('metro-config/src/defaults/defaults').moduleSystem = require.resolve(
      '@expo/cli/build/metro-require/require'
    );
  }
  if (env.EXPO_BUNDLE_BUILT_IN) {
    require('metro-config/src/defaults/defaults').moduleSystem = require.resolve(
      '@expo/cli/build/metro-require/native-require'
    );
    config.transformer!.globalPrefix = '__native';
  }

  if (!config.projectRoot) {
    // @ts-expect-error: read-only types
    config.projectRoot = projectRoot;
  }

  // Required for @expo/metro-runtime to format paths in the web LogBox.
  process.env.EXPO_PUBLIC_PROJECT_ROOT = process.env.EXPO_PUBLIC_PROJECT_ROOT ?? projectRoot;

  // This is used for running Expo CLI in development against projects outside the monorepo.
  if (!isDirectoryIn(__dirname, projectRoot)) {
    if (!config.watchFolders) {
      // @ts-expect-error: watchFolders is readonly
      config.watchFolders = [];
    }
    // @ts-expect-error: watchFolders is readonly
    config.watchFolders.push(path.join(require.resolve('metro-runtime/package.json'), '../..'));
    // @ts-expect-error: watchFolders is readonly
    config.watchFolders.push(
      path.join(require.resolve('@expo/metro-config/package.json'), '../..'),
      // For virtual modules
      path.join(require.resolve('expo/package.json'), '..')
    );
    if (isReactCanaryEnabled) {
      // @ts-expect-error: watchFolders is readonly
      config.watchFolders.push(path.join(require.resolve('@expo/cli/package.json'), '..'));
    }
  }

  // TODO: Remove this
  // @ts-expect-error: Invalidate the cache when the location of expo-router changes on-disk.
  config.transformer._expoRouterPath = resolveFrom.silent(projectRoot, 'expo-router');

  let tsconfig: null | TsConfigPaths = null;

  if (isTsconfigPathsEnabled) {
    tsconfig = await loadTsConfigPathsAsync(projectRoot);
  }

  let expoConfigPlatforms = Object.entries(platformBundlers)
    .filter(
      ([platform, bundler]) => bundler === 'metro' && exp.platforms?.includes(platform as Platform)
    )
    .map(([platform]) => platform);

  if (Array.isArray(config.resolver.platforms)) {
    expoConfigPlatforms = [...new Set(expoConfigPlatforms.concat(config.resolver.platforms))];
  }

  // @ts-expect-error: typed as `readonly`.
  config.resolver.platforms = expoConfigPlatforms;

  config = withWebPolyfills(config, { getMetroBundler });

  let stickyModuleResolverInput: StickyModuleResolverInput | undefined;
  if (isStickyResolverEnabled) {
    stickyModuleResolverInput = await createStickyModuleResolverInput({
      platforms: expoConfigPlatforms,
      projectRoot,
    });
  }

  return withExtendedResolver(config, {
    stickyModuleResolverInput,
    tsconfig,
    isExporting,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isReactCanaryEnabled,
    isReactServerComponentsEnabled,
    getMetroBundler,
  });
}

function isDirectoryIn(targetPath: string, rootPath: string) {
  return targetPath.startsWith(rootPath) && targetPath.length >= rootPath.length;
}

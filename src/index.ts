import { join, resolve, posix } from "path";
import {
  getOptions,
  interpolateName,
  OptionObject,
  stringifyRequest,
} from "loader-utils";
import * as webpack from "webpack";
import { readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { spawn, execFile } from "child_process";
import { copyFile } from "./utils";
// import validateOptions from "schema-utils"

export interface loaderOptions {
  root: string; // default process.env.GOROOT
  bridge: string; // file path of goBridge
  wasmExecPath: string; // wasm_exec.js path
  goCompiler: GoCompiler;
  name?: string;
  outputPath?:
    | string
    | ((
        url: string,
        resourcePath: string,
        context: string | boolean
      ) => string);
}

export interface GoCompiler {
  bin: (root: string) => string | string;
  args: (resourcePath: string) => string[] | string[];
}

export default function (this: webpack.loader.LoaderContext, content: string) {
  const callback = this.async() as webpack.loader.loaderCallback;

  (async function (ctx) {
    const [
      goVersion,
      goPath,
      {
        goCompiler: { bin, args },
        root,
        wasmExecPath,
        bridge,
        context = ctx.rootContext,
        outputPath,
        name = "[contenthash].[ext]",
      },
    ] = await Promise.all([
      getGoVersion(),
      getGoEnv("GOPATH"),
      getLoaderOptions(ctx),
    ]);
    const copyWasmDir = join(__dirname, "../dist", goVersion);
    const copyWasmExecPath = join(copyWasmDir, "wasm_exec.js");

    if (!existsSync(copyWasmDir)) {
      mkdirSync(copyWasmDir, { recursive: true });
    }

    if (!existsSync(copyWasmExecPath)) {
      copyFile(wasmExecPath, copyWasmExecPath);
    }

    const outFile = `${ctx.resourcePath}.wasm`;
    const goBin = typeof bin === "function" ? bin(root) : bin;
    const _args = typeof args === "function" ? args(ctx.resourcePath) : args;
    const processOpts = {
      env: {
        ...process.env,
        GOPATH: goPath,
        GOROOT: root,
        GOCACHE: join(__dirname, "./.gocache"),
        GOOS: "js",
        GOARCH: "wasm",
      },
    };

    const immutable = /\[([^:\]]+:)?(hash|contenthash)(:[^\]]+)?\]/gi.test(
      name
    );

    const url = interpolateName(ctx, name, {
      context,
      content,
    });

    let outPath = url;

    if (outputPath) {
      if (typeof outputPath === "function") {
        outPath = outputPath(url, ctx.resourcePath, context);
      } else {
        outPath = posix.join(outputPath, url);
      }
    }

    try {
      await compileWasm(goBin, _args, processOpts);
    } catch (error) {
      console.trace(error);
      throw error;
    }

    const out = readFileSync(outFile);
    unlinkSync(outFile);

    // const emittedFilename = basename(ctx.resourcePath, ".go") + ".wasm";
    const emittedFilename = outPath.replace(/\.go$/, ".wasm");
    const publicPath = `__webpack_public_path__ + ${JSON.stringify(
      emittedFilename
    )}`;
    // @ts-ignore
    ctx.emitFile(emittedFilename, out, null, { immutable });

    callback(
      null,
      [
        "require(",
        stringifyRequest(ctx, copyWasmExecPath),
        ");",
        "import gobridge from ",
        stringifyRequest(ctx, bridge),
        ";",
        proxyBuilder(publicPath),
      ].join("")
    );
  })(this);
}

async function getLoaderOptions(
  context: webpack.loader.LoaderContext
): Promise<loaderOptions & OptionObject> {
  const options = getOptions(context);
  const goRoot = await getGoEnv("GOROOT");
  const goCompiler: GoCompiler = {
    bin: (root: string) => join(root, "bin/go"),
    args: (resourcePath: string) => [
      "build",
      "-o",
      `${resourcePath}.wasm`,
      resourcePath,
    ],
  };
  return {
    goCompiler,
    root: goRoot,
    wasmExecPath: resolve(goRoot, "misc/wasm/wasm_exec.js"),
    bridge: join(__dirname, "..", "dist", "gobridge.js"),
    ...options,
  } as loaderOptions & OptionObject;
}

function getGoVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ls = spawn("go", ["version"]);
    ls.stdout.on("data", (buf: Buffer) => {
      const [, , ret] = buf.toString().split(" ");
      resolve(ret);
    });

    ls.stderr.on("data", (data) => {
      reject(new Error(`Child Process getGoRoot error: ${data}`));
    });
  });
}
function getGoEnv(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ls = spawn("go", ["env", name]);
    ls.stdout.on("data", (buf: Buffer) => {
      const [ret] = buf.toString().split("\n");
      resolve(ret);
    });

    ls.stderr.on("data", (data) => {
      reject(new Error(`Child Process getGoRoot error: ${data}`));
    });
  });
}

function compileWasm(bin: string, args: string[], options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, options, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(true);
    });
  });
}

const proxyBuilder = (filename: string) =>
  `export default gobridge(fetch(${filename}).then(response => response.arrayBuffer()));`;

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import { GitHub, getOctokitOptions } from "@actions/github/lib/utils";
import { throttling } from "@octokit/plugin-throttling";

const ThrottlingOctokit = GitHub.plugin(throttling);

interface ToolInfo {
  owner: string;
  project: string;
  tag: string;
  osPlatform: string;
  osArch: string;
}

async function run() {
  try {
    // set up auth/environment
    const token = process.env['GITHUB_TOKEN'] || core.getInput("token")
    const octokit = new ThrottlingOctokit({
        throttle: {
            onRateLimit: (retryAfter, options) => {
                core.warning(
                    `RateLimit detected for request ${options.method} ${options.url}.`
                );
                core.info(`Retrying after ${retryAfter} seconds.`);
                return true;
            },
            onSecondaryRateLimit: (retryAfter, options) => {
                core.warning(
                    `SecondaryRateLimit detected for request ${options.method} ${options.url}.`
                );
                core.info(`Retrying after ${retryAfter} seconds.`);
                return true;
            },
        },
        ...getOctokitOptions(token),
    })
    
    const owner = "getnoops"
    const project = "ops"
    
    let tag = core.getInput("tag");
    tag = !tag ? "latest" : tag

    const osMatch: string[] = []

    // get the platform
    let osPlatform = core.getInput("platform");
    if (osPlatform === "") {
      switch (os.platform()) {
          case "linux":
              osPlatform = "linux";
              break;
          case "darwin":
              osPlatform = "darwin";
              break;
          case "win32":
              osPlatform = "windows";
              break;
          default:
              core.setFailed("Unsupported operating system - $this action is only released for Darwin, Linux and Windows");
              return;
      }
    }
    osMatch.push(osPlatform)
    core.info(`==> System reported platform: ${os.platform()}`)
    core.info(`==> Using platform: ${osPlatform}`)
    
    // Determine Architecture
    const osArch = core.getInput("arch") || os.arch();
    switch (osArch) {
      case "x64":
          osMatch.push("x86_64", "x64", "amd64")
          break;
      default:
          osMatch.push(osArch)
          break;
    }
    core.info(`==> System reported arch: ${os.arch()}`)
    core.info(`==> Using arch: ${osArch}`)
    
    const cacheEnabled = (core.getInput("cache") === "enable") && tag !== "latest" && tag !== "";
    
    const toolInfo: ToolInfo = {
      owner: owner,
      project: project,
      tag: tag,
      osArch: osArch,
      osPlatform: osPlatform
    };
    const dest = toolPath(toolInfo);

    // Look in the cache first.
    const cacheKey = cachePrimaryKey(toolInfo);
    if (cacheEnabled && cacheKey !== undefined) {
        const ok = await cache.restoreCache([dest], cacheKey);
        if (ok !== undefined) {
            core.info(`Found ${project} in the cache: ${dest}`)
            core.info(`Adding ${dest} to the path`);
            core.addPath(dest);
            return;
        }
    }

    let getReleaseUrl;
    if (tag === "latest") {
      getReleaseUrl = await octokit.rest.repos.getLatestRelease({
          owner: owner,
          repo: project,
      })
    } else {
      getReleaseUrl = await octokit.rest.repos.getReleaseByTag({
          owner: owner,
          repo: project,
          tag: tag,
      })
    }
    
    const extMatchRegexForm = `\\.(tar.gz|zip)`;
    const osMatchRegexForm = `(${osMatch.join('|')})`
    const re = new RegExp(`${osMatchRegexForm}.*${osMatchRegexForm}.*${extMatchRegexForm}`)

    const asset = getReleaseUrl.data.assets.find(obj => {
      const normalized_obj_name = obj.name.toLowerCase()
      return re.test(normalized_obj_name)
    })
    
    if (!asset) {
      const found = getReleaseUrl.data.assets.map(f => f.name)
      throw new Error(`Could not find a release for ${tag}. Found: ${found}`)
    }
    
    core.info(`Downloading ${project} from ${asset.url}`)
    
    const binPath = await tc.downloadTool(asset.url,
        undefined,
        `token ${token}`,
        {
            accept: 'application/octet-stream'
        }
    );
    core.info(`Downloaded ${project} to ${binPath}`);
    
    const extractFn = getExtractFn(asset.name)
    if (extractFn === undefined) {
        throw new Error(`Unsupported archive type: ${asset.name}`);
    }

    const extractFlags = getExtractFlags(asset.name);
    await extractFn(binPath, dest, extractFlags);
    core.info(`Automatically extracted release asset ${asset.name} to ${dest}`);

    const bins = fs.readdirSync(dest, { withFileTypes: true })
      .filter(item => item.isFile())
      .map(bin => bin.name);

    if (bins.length === 0) {
        throw new Error(`No files found in ${dest}`);
    }

    const chmodTo = core.getInput("chmod") || "755";
    bins.forEach(bin => {
        const binPath = path.join(dest, bin);
        try {
            fs.chmodSync(binPath, chmodTo);
            core.info(`chmod'd ${binPath} to ${chmodTo}`)
        } catch (chmodErr) {
            core.setFailed(`Failed to chmod ${binPath} to ${chmodTo}: ${chmodErr}`);
        }
    });
    
    if (cacheEnabled && cacheKey !== undefined) {
      try {
          await cache.saveCache([dest], cacheKey);
      } catch (error) {
          const typedError = error as Error;
          if (typedError.name === cache.ValidationError.name) {
              throw error;
          } else if (typedError.name === cache.ReserveCacheError.name) {
              core.info(typedError.message);
          } else {
              core.warning(typedError.message);
          }
      }
    }

    core.info(`Adding ${dest} to the path`);
    core.addPath(dest);
    core.info(`Successfully installed ${project}`);
    core.info(`Binaries available at ${dest}`);
  } catch (error) {
    if (error instanceof Error) {
        core.setFailed(error.message);
    } else {
        core.setFailed("catastrophic failure, please file an issue")
    }
  }
}

function cachePrimaryKey(info: ToolInfo): string | undefined {
  // Currently not caching "latest" versions of the tool.
  if (info.tag === "latest") {
      return undefined;
  }
  return "action-install-gh-release/" +
      `${info.owner}/${info.project}/${info.tag}/${info.osPlatform}-${info.osArch}`;
}

function toolPath(info: ToolInfo): string {
  return path.join(getCacheDirectory(),
      info.owner, info.project, info.tag,
      `${info.osPlatform}-${info.osArch}`);
}

function getCacheDirectory() {
    const cacheDirectory = process.env['RUNNER_TOOL_CACHE'] || '';
    if (cacheDirectory === '') {
      core.warning('Expected RUNNER_TOOL_CACHE to be defined');
    }
    return cacheDirectory;
}

function getExtractFn(assetName: any) {
  if (assetName.endsWith('.tar.gz') || assetName.endsWith('.tar.bz2')) {
      return tc.extractTar;
  } else if (assetName.endsWith('.zip')) {
      return tc.extractZip;
  } else {
      return undefined;
  }
}

function getExtractFlags(assetName: any) {
  if (assetName.endsWith('tar.bz2')) {
      return "xj";
  } else {
      return undefined;
  }
}

run();
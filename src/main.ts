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
  } catch (error) {
    if (error instanceof Error) {
        core.setFailed(error.message);
    } else {
        core.setFailed("catastrophic failure, please file an issue")
    }
  }
}

run();
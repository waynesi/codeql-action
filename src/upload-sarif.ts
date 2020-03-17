import * as core from '@actions/core';
import * as http from '@actions/http-client';
import * as auth from '@actions/http-client/auth';
import * as fs from 'fs';
import zlib from 'zlib';

import * as configUtils from './config-utils';
import * as upload_lib from './upload-lib';
import * as util from './util';

async function run() {
    if (util.should_abort('upload-sarif') || !await util.reportActionStarting('upload-sarif')) {
        return;
    }

    try {
        const config = await configUtils.loadConfig();

        const sarifFile = core.getInput('sarif_file');
        await upload_lib.upload_sarif(sarifFile);
    } catch (error) {
        core.setFailed(error.message);
        await util.reportActionFailed('upload-sarif', 'unspecified');
        return;
    }

    await util.reportActionSucceeded('upload-sarif');
}

void run();

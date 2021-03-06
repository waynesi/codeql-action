"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const io = __importStar(require("@actions/io"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const analysisPaths = __importStar(require("./analysis-paths"));
const configUtils = __importStar(require("./config-utils"));
const setuptools = __importStar(require("./setup-tools"));
const sharedEnv = __importStar(require("./shared-environment"));
const util = __importStar(require("./util"));
const CRITICAL_TRACER_VARS = new Set(['SEMMLE_PRELOAD_libtrace',
    ,
    'SEMMLE_RUNNER',
    ,
    'SEMMLE_COPY_EXECUTABLES_ROOT',
    ,
    'SEMMLE_DEPTRACE_SOCKET',
    ,
    'SEMMLE_JAVA_TOOL_OPTIONS'
]);
async function tracerConfig(codeql, database, compilerSpec) {
    const compilerSpecArg = compilerSpec ? ["--compiler-spec=" + compilerSpec] : [];
    let envFile = path.resolve(database, 'working', 'env.tmp');
    await exec.exec(codeql.cmd, ['database', 'trace-command', database,
        ...compilerSpecArg,
        process.execPath, path.resolve(__dirname, 'tracer-env.js'), envFile]);
    const env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
    const config = env['ODASA_TRACER_CONFIGURATION'];
    const info = { spec: config, env: {} };
    // Extract critical tracer variables from the environment
    for (let entry of Object.entries(env)) {
        const key = entry[0];
        const value = entry[1];
        // skip ODASA_TRACER_CONFIGURATION as it is handled separately
        if (key === 'ODASA_TRACER_CONFIGURATION') {
            continue;
        }
        // skip undefined values
        if (typeof value === 'undefined') {
            continue;
        }
        // Keep variables that do not exist in current environment. In addition always keep
        // critical and CODEQL_ variables
        if (typeof process.env[key] === 'undefined' || CRITICAL_TRACER_VARS.has(key) || key.startsWith('CODEQL_')) {
            info.env[key] = value;
        }
    }
    return info;
}
function concatTracerConfigs(configs) {
    // A tracer config is a map containing additional environment variables and a tracer 'spec' file.
    // A tracer 'spec' file has the following format [log_file, number_of_blocks, blocks_text]
    // Merge the environments
    const env = {};
    let copyExecutables = false;
    let envSize = 0;
    for (let v of Object.values(configs)) {
        for (let e of Object.entries(v.env)) {
            const name = e[0];
            const value = e[1];
            // skip SEMMLE_COPY_EXECUTABLES_ROOT as it is handled separately
            if (name === 'SEMMLE_COPY_EXECUTABLES_ROOT') {
                copyExecutables = true;
            }
            else if (name in env) {
                if (env[name] !== value) {
                    throw Error('Incompatible values in environment parameter ' +
                        name + ': ' + env[name] + ' and ' + value);
                }
            }
            else {
                env[name] = value;
                envSize += 1;
            }
        }
    }
    // Concatenate spec files into a new spec file
    let languages = Object.keys(configs);
    const cppIndex = languages.indexOf('cpp');
    // Make sure cpp is the last language, if it's present since it must be concatenated last
    if (cppIndex !== -1) {
        let lastLang = languages[languages.length - 1];
        languages[languages.length - 1] = languages[cppIndex];
        languages[cppIndex] = lastLang;
    }
    let totalLines = [];
    let totalCount = 0;
    for (let lang of languages) {
        const lines = fs.readFileSync(configs[lang].spec, 'utf8').split(/\r?\n/);
        const count = parseInt(lines[1], 10);
        totalCount += count;
        totalLines.push(...lines.slice(2));
    }
    const newLogFilePath = path.resolve(util.workspaceFolder(), 'compound-build-tracer.log');
    const spec = path.resolve(util.workspaceFolder(), 'compound-spec');
    const tempFolder = path.resolve(util.workspaceFolder(), 'compound-temp');
    const newSpecContent = [newLogFilePath, totalCount.toString(10), ...totalLines];
    if (copyExecutables) {
        env['SEMMLE_COPY_EXECUTABLES_ROOT'] = tempFolder;
        envSize += 1;
    }
    fs.writeFileSync(spec, newSpecContent.join('\n'));
    // Prepare the content of the compound environment file
    let buffer = Buffer.alloc(4);
    buffer.writeInt32LE(envSize, 0);
    for (let e of Object.entries(env)) {
        const key = e[0];
        const value = e[1];
        const lineBuffer = new Buffer(key + '=' + value + '\0', 'utf8');
        const sizeBuffer = Buffer.alloc(4);
        sizeBuffer.writeInt32LE(lineBuffer.length, 0);
        buffer = Buffer.concat([buffer, sizeBuffer, lineBuffer]);
    }
    // Write the compound environment
    const envPath = spec + '.environment';
    fs.writeFileSync(envPath, buffer);
    return { env, spec };
}
async function run() {
    try {
        if (util.should_abort('init', false) || !await util.reportActionStarting('init')) {
            return;
        }
        // The config file MUST be parsed in the init action
        const config = await configUtils.loadConfig();
        core.startGroup('Load language configuration');
        const languages = await util.getLanguages();
        // If the languages parameter was not given and no languages were
        // detected then fail here as this is a workflow configuration error.
        if (languages.length === 0) {
            core.setFailed("Did not detect any languages to analyze. Please update input in workflow.");
            return;
        }
        core.endGroup();
        analysisPaths.includeAndExcludeAnalysisPaths(config, languages);
        const sourceRoot = path.resolve();
        core.startGroup('Setup CodeQL tools');
        const codeqlSetup = await setuptools.setupCodeQL();
        await exec.exec(codeqlSetup.cmd, ['version', '--format=json']);
        core.endGroup();
        // Forward Go flags
        const goFlags = process.env['GOFLAGS'];
        if (goFlags) {
            core.exportVariable('GOFLAGS', goFlags);
            core.warning("Passing the GOFLAGS env parameter to the codeql/init action is deprecated. Please move this to the codeql/finish action.");
        }
        // Setup CODEQL_RAM flag (todo improve this https://github.com/github/dsp-code-scanning/issues/935)
        const codeqlRam = process.env['CODEQL_RAM'] || '6500';
        core.exportVariable('CODEQL_RAM', codeqlRam);
        const databaseFolder = path.resolve(util.workspaceFolder(), 'codeql_databases');
        await io.mkdirP(databaseFolder);
        let tracedLanguages = {};
        let scannedLanguages = [];
        // TODO: replace this code once CodeQL supports multi-language tracing
        for (let language of languages) {
            const languageDatabase = path.join(databaseFolder, language);
            // Init language database
            await exec.exec(codeqlSetup.cmd, ['database', 'init', languageDatabase, '--language=' + language, '--source-root=' + sourceRoot]);
            // TODO: add better detection of 'traced languages' instead of using a hard coded list
            if (['cpp', 'java', 'csharp'].includes(language)) {
                const config = await tracerConfig(codeqlSetup, languageDatabase);
                tracedLanguages[language] = config;
            }
            else {
                scannedLanguages.push(language);
            }
        }
        const tracedLanguageKeys = Object.keys(tracedLanguages);
        if (tracedLanguageKeys.length > 0) {
            const mainTracerConfig = concatTracerConfigs(tracedLanguages);
            if (mainTracerConfig.spec) {
                for (let entry of Object.entries(mainTracerConfig.env)) {
                    core.exportVariable(entry[0], entry[1]);
                }
                core.exportVariable('ODASA_TRACER_CONFIGURATION', mainTracerConfig.spec);
                if (process.platform === 'darwin') {
                    core.exportVariable('DYLD_INSERT_LIBRARIES', path.join(codeqlSetup.tools, 'osx64', 'libtrace.dylib'));
                }
                else if (process.platform === 'win32') {
                    await exec.exec('powershell', [path.resolve(__dirname, '..', 'src', 'inject-tracer.ps1'),
                        path.resolve(codeqlSetup.tools, 'win64', 'tracer.exe')], { env: { 'ODASA_TRACER_CONFIGURATION': mainTracerConfig.spec } });
                }
                else {
                    core.exportVariable('LD_PRELOAD', path.join(codeqlSetup.tools, 'linux64', '${LIB}trace.so'));
                }
            }
        }
        core.exportVariable(sharedEnv.CODEQL_ACTION_SCANNED_LANGUAGES, scannedLanguages.join(','));
        core.exportVariable(sharedEnv.CODEQL_ACTION_TRACED_LANGUAGES, tracedLanguageKeys.join(','));
        // TODO: make this a "private" environment variable of the action
        core.exportVariable(sharedEnv.CODEQL_ACTION_DATABASE_DIR, databaseFolder);
        core.exportVariable(sharedEnv.CODEQL_ACTION_CMD, codeqlSetup.cmd);
    }
    catch (error) {
        core.setFailed(error.message);
        await util.reportActionFailed('init', error.message, error.stack);
        return;
    }
    core.exportVariable(sharedEnv.CODEQL_ACTION_INIT_COMPLETED, 'true');
    await util.reportActionSucceeded('init');
}
run().catch(e => {
    core.setFailed("codeql/init action failed: " + e);
    console.log(e);
});

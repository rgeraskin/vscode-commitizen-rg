import { exec } from 'child_process';
import execa from 'execa';
import { join } from 'path';
import * as sander from 'sander';
// tslint:disable-next-line:no-implicit-dependencies
import * as vscode from 'vscode';
import wrap from 'wrap-ansi';

let channel: vscode.OutputChannel;

interface Configuration {
  autoSync: boolean;
  subjectLength: number;
  showOutputChannel: 'off' | 'always' | 'onError';
  capitalizeWindowsDriveLetter: boolean;
  useGitRoot: boolean;
  shell: boolean;
  signCommits: boolean;
  configAbsPath?: string;
}

function getConfiguration(): Configuration {
  const config = vscode.workspace
    .getConfiguration()
    .get<Configuration>('commitizen');
  return config!;
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  channel = vscode.window.createOutputChannel('commitizen');
  channel.appendLine('Commitizen support started');

  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-commitizen-rg.commit', async () => {
      const lookupPath = await findLookupPath();
      if (lookupPath) {
        const czConfig = await readCzConfig(lookupPath);
        const ccm = new ConventionalCommitMessage(czConfig);
        await ccm.getType();
        await ccm.getScope();
        await ccm.getSubject();
        await ccm.getBody();
        await ccm.getBreaking();
        await ccm.getFooter();
        if (ccm.complete) {
          await commit(lookupPath, ccm.messages);
        }
      } else {
        channel.appendLine('Lookup path not found');
      }
    })
  );
}

interface CzConfig {
  types: {
    value: string;
    name: string;
  }[];
  scopes: {
    name?: string;
  }[];
  messages: {
    type?: string;
    customScope?: string;
    scope?: string;
    subject?: string;
    body?: string;
    breaking?: string;
    footer?: string;
  };
  allowCustomScopes: boolean;
  allowBreakingChanges: string[];
  footerPrefix: string;
  skipQuestions?: string[];
}
type Messages = {
  main: string;
  body: string;
  footer: string;
};

let gitRoot: string | undefined = undefined;
async function findLookupPath(): Promise<string | undefined> {
  let ws = '';
  if (!vscode.workspace.workspaceFolders) {
    return undefined;
  } else if (vscode.workspace.workspaceFolders.length > 1) {
    const repositories = {};
    vscode.workspace.workspaceFolders.forEach(
      (folder: vscode.WorkspaceFolder) => {
        (repositories as Record<string, { label: string, description: string }>)[folder.name] = {
          label: folder.name,
          description: folder.uri.fsPath
        };
      }
    );

    const pickOptions: vscode.QuickPickOptions = {
      placeHolder: 'Select a folder',
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true
    };
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem>(
      Object.values(repositories),
      pickOptions
    );
    if (pick) {
      ws = (repositories as Record<string, { label: string, description: string }>)[pick.label].description;
    }
  } else {
    ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  if (getConfiguration().useGitRoot) {
    if (gitRoot === undefined) {
      gitRoot = await new Promise<string>((resolve, reject) =>
        exec(
          'git rev-parse --show-toplevel',
          { cwd: ws },
          (err, stdout, stderr) => {
            if (err) {
              reject({ err, stderr });
            } else if (stdout) {
              channel.appendLine(`Found git root at: ${stdout}`);
              resolve(stdout.trim());
            } else {
              reject({ err: 'Unable to find git root' });
            }
          }
        )
      ).catch((e) => {
        channel.appendLine(e.err.toString());
        if (e.stderr) {
          channel.appendLine(e.stderr.toString());
        }
        return undefined;
      });
    }

    return gitRoot;
  }

  return ws;
}

async function readCzConfig(lookupPath: string): Promise<CzConfig | undefined> {
  const config = getConfiguration();
  let configPath: string;

  // If useGitRoot is true and we're in a git root, check there first
  if (config.useGitRoot && gitRoot) {
    channel.appendLine(`gitRoot setting is set and git root is: ${gitRoot}`);
    configPath = join(gitRoot, '.cz-config.js');
    if (await sander.exists(configPath)) {
      channel.appendLine(`Found config in git root: ${configPath}`);
      return require(configPath) as CzConfig;
    }
    channel.appendLine(`No config found in git root: ${configPath}`);
  }

  // Then check workspace directory
  configPath = join(lookupPath, '.cz-config.js');
  if (await sander.exists(configPath)) {
    channel.appendLine(`Found config in workspace: ${configPath}`);
    return require(configPath) as CzConfig;
  }
  channel.appendLine(`No config found in workspace: ${configPath}`);

  // Check package.json in workspace
  const pkg = await readPackageJson(lookupPath);
  if (pkg && hasCzConfig(pkg)) {
    configPath = join(lookupPath, pkg.config['cz-customizable'].config);
    if (await sander.exists(configPath)) {
      channel.appendLine(`Found config from package.json: ${configPath}`);
      return require(configPath) as CzConfig;
    }
    channel.appendLine(`No config found in package.json: ${configPath}`);
  }

  // Finally check configAbsPath if set
  if (config.configAbsPath) {
    channel.appendLine(`configAbsPath is set to: ${config.configAbsPath}`);
    const customConfigPath = config.configAbsPath.replace(
      '${userHome}',
      require('os').homedir()
    );

    if (await sander.exists(customConfigPath)) {
      channel.appendLine(`Found config at configAbsPath: ${customConfigPath}`);
      return require(customConfigPath) as CzConfig;
    }
    channel.appendLine(`Warning: Configured configAbsPath not found: ${customConfigPath}`);
  }
  channel.appendLine(`Using default config`);
  return undefined;
}

async function readPackageJson(
  lookupPath: string
): Promise<object | undefined> {
  const pkgPath = join(lookupPath, 'package.json');
  if (!(await sander.exists(pkgPath))) {
    return undefined;
  }
  return JSON.parse(await sander.readFile(pkgPath));
}

function hasCzConfig(
  pkg: any
): pkg is { config: { 'cz-customizable': { config: string } } } {
  return (
    pkg.config &&
    pkg.config['cz-customizable'] &&
    pkg.config['cz-customizable'].config
  );
}

async function askOneOf(
  question: string,
  picks: vscode.QuickPickItem[],
  save: (pick: vscode.QuickPickItem) => void,
  customLabel?: string,
  customQuestion?: string
): Promise<boolean> {
  const pickOptions: vscode.QuickPickOptions = {
    placeHolder: question,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  };
  const pick = await vscode.window.showQuickPick(picks, pickOptions);
  if (pick && pick.label === customLabel && !!customQuestion) {
    const next = await ask(customQuestion || '', (input) => {
      save({ label: input, description: '' });
      return true;
    });
    return next;
  }
  if (pick === undefined) {
    return false;
  }
  save(pick);
  return true;
}

async function ask(
  question: string,
  save: (input: string) => void,
  validate?: (input: string) => string
): Promise<boolean> {
  const options: vscode.InputBoxOptions = {
    placeHolder: question,
    ignoreFocusOut: true
  };
  if (validate) {
    options.validateInput = validate;
  }
  const input = await vscode.window.showInputBox(options);
  if (input === undefined) {
    return false;
  }
  save(input);
  return true;
}

const DEFAULT_TYPES = [
  {
    value: 'feat',
    name: 'A new feature'
  },
  {
    value: 'fix',
    name: 'A bug fix'
  },
  {
    value: 'docs',
    name: 'Documentation only changes'
  },
  {
    value: 'style',
    name:
      'Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)'
  },
  {
    value: 'refactor',
    name: 'A code change that neither fixes a bug nor adds a feature'
  },
  {
    value: 'perf',
    name: 'A code change that improves performance'
  },
  {
    value: 'test',
    name: 'Adding missing tests or correcting existing tests'
  },
  {
    value: 'build',
    name:
      'Changes that affect the build system or external dependencies (example scopes: gulp, broccoli, npm)'
  },
  {
    value: 'ci',
    name:
      'Changes to our CI configuration files and scripts (example scopes: Travis, Circle, BrowserStack, SauceLabs)'
  },
  {
    value: 'chore',
    name: "Other changes that don't modify src or test files"
  }
];

const DEFAULT_MESSAGES = {
  type: "Select the type of change that you're committing",
  customScope: 'Denote the SCOPE of this change',
  customScopeEntry: 'Custom scope...',
  scope: 'Denote the SCOPE of this change (optional)',
  subject: 'Write a SHORT, IMPERATIVE tense description of the change',
  body:
    'Provide a LONGER description of the change (optional). Use "|" to break new line',
  breaking: 'List any BREAKING CHANGES (optional)',
  footer: 'List any ISSUES CLOSED by this change (optional). E.g.: #31, #34'
};

const splitMessages = (message: string) => {
  const result: string[] = [];

  if (message.includes('|')) {
    message.split('|').forEach((msg) => {
      result.push('-m', `"${msg}"`);
    });
  } else {
    result.push('-m', `"${message}"`);
  }

  return result;
};

const buildCommitArguments = (message: Messages): string[] => {
  const messageArguments = ['-m', `"${message.main}"`];

  if (message.body) {
    messageArguments.push(...splitMessages(message.body));
  }

  if (message.footer) {
    messageArguments.push(...splitMessages(message.footer));
  }

  const signArgument = getConfiguration().signCommits ? ['-S'] : [];

  return [...messageArguments, ...signArgument];
};

async function commit(cwd: string, message: Messages): Promise<void> {
  channel.appendLine(`About to commit '${message.main}'`);

  try {
    await conditionallyStageFiles(cwd);
    const result = await execa('git', ['commit', ...buildCommitArguments(message)], {
      cwd: getGitCwd(cwd),
      preferLocal: false,
      shell: getConfiguration().shell
    });
    if (getConfiguration().autoSync) {
      await execa('git', ['sync'], { cwd });
    }
    if (hasOutput(result)) {
      result.stdout.split('\n').forEach((line) => channel.appendLine(line));
      if (shouldShowOutput(result)) {
        channel.show();
      }
    }
  } catch (e: any) {
    // Format the commit message for the input box
    const formattedMessage = formatCommitMessage(message);

    // Get the Git extension
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const git = gitExtension.exports.getAPI(1);
      const repo = git.repositories[0];
      if (repo) {
        // Set the commit message in the source control input box
        repo.inputBox.value = formattedMessage;
      }
    }

    vscode.window.showErrorMessage(e.message);
    channel.appendLine(e.message);
    channel.appendLine(e.stack);
  }
}

function formatCommitMessage(message: Messages): string {
  let formattedMessage = message.main;

  if (message.body) {
    formattedMessage += '\n\n' + message.body.replace(/\|/g, '\n');
  }

  if (message.footer) {
    formattedMessage += '\n\n' + message.footer.replace(/\|/g, '\n');
  }

  return formattedMessage;
}

function hasOutput(result?: { stdout?: string }): boolean {
  return Boolean(result && result.stdout);
}

function shouldShowOutput(result: { exitCode: number }): boolean {
  return (
    getConfiguration().showOutputChannel === 'always' ||
    (getConfiguration().showOutputChannel === 'onError' && result.exitCode > 0)
  );
}

async function conditionallyStageFiles(cwd: string): Promise<void> {
  const hasSmartCommitEnabled =
    vscode.workspace
      .getConfiguration('git')
      .get<boolean>('enableSmartCommit') === true;

  if (hasSmartCommitEnabled && !(await hasStagedFiles(cwd))) {
    channel.appendLine(
      'Staging all files (enableSmartCommit enabled with nothing staged)'
    );
    await execa('git', ['add', '.'], {
      cwd
    });
  }
}

async function hasStagedFiles(cwd: string): Promise<boolean> {
  const result = await execa('git', ['diff', '--name-only', '--cached'], {
    cwd
  });
  return hasOutput(result);
}

class ConventionalCommitMessage {
  private static shouldSkip(
    czConfig: CzConfig | undefined,
    messageType: string
  ): boolean {
    return Boolean(
      czConfig &&
      czConfig.skipQuestions &&
      czConfig.skipQuestions.includes(messageType)
    );
  }

  private static hasScopes(
    czConfig: CzConfig | undefined
  ): czConfig is CzConfig {
    return Boolean(czConfig && czConfig.scopes && czConfig.scopes.length !== 0);
  }

  private static hasCustomMessage(
    czConfig: CzConfig | undefined,
    messageType: string
  ): czConfig is CzConfig {
    return Boolean(
      czConfig &&
      czConfig.messages &&
      czConfig.messages.hasOwnProperty(messageType)
    );
  }

  private static getScopePicks(
    czConfig: CzConfig,
    allowCustomScopesLabel: string
  ): { label: string; description: string }[] {
    const scopePicks = czConfig.scopes.map((scope) => ({
      label: scope.name || (scope as string),
      description: ''
    }));
    if (czConfig.allowCustomScopes) {
      scopePicks.push({
        label: allowCustomScopesLabel,
        description: ''
      });
    }
    return scopePicks;
  }

  private static allowBreakingChanges(
    czConfig: CzConfig | undefined,
    selectedType: string | undefined
  ): boolean {
    if (czConfig?.allowBreakingChanges && selectedType) {
      return czConfig?.allowBreakingChanges.some(
        (type: string) => type === selectedType
      );
    }

    return true;
  }

  private readonly czConfig: CzConfig | undefined;
  private next = true;

  private type?: string;
  private scope: string | undefined;
  private subject?: string;
  private body: string | undefined;
  private breaking: string | undefined;
  private footer: string | undefined;

  constructor(czConfig: CzConfig | undefined) {
    this.czConfig = czConfig;
  }

  public async getType(): Promise<void> {
    if (this.next) {
      const types = (this.czConfig && this.czConfig.types) || DEFAULT_TYPES;
      const typePicks = types.map((type) => ({
        label: type.value,
        description: type.name
      }));
      this.next = await askOneOf(
        this.inputMessage('type'),
        typePicks,
        (pick) => (this.type = pick.label)
      );
    }
  }

  public async getScope(): Promise<void> {
    if (this.next && !ConventionalCommitMessage.shouldSkip(this.czConfig, 'scope')) {
      if (
        ConventionalCommitMessage.hasScopes(this.czConfig)
      ) {
        if (this.czConfig.scopes && this.czConfig.scopes[0] !== undefined) {
          const scopePicks = ConventionalCommitMessage.getScopePicks(
            this.czConfig,
            this.inputMessage('customScopeEntry')
          );
          this.next = await askOneOf(
            this.inputMessage('customScope'),
            scopePicks,
            (pick) => {
              this.scope = pick.label || undefined;
            },
            this.inputMessage('customScopeEntry'),
            this.inputMessage('customScope')
          );
        }
      } else {
        this.next = await ask(
          this.inputMessage('scope'),
          (input) => (this.scope = input)
        );
      }
    }
  }

  public async getSubject(): Promise<void> {
    if (this.next) {
      const maxLength = getConfiguration().subjectLength;
      const validator = (input: string) => {
        if (input.length === 0 || input.length > maxLength) {
          return `Subject is required and must be less than ${maxLength} characters`;
        }
        return '';
      };
      this.next = await ask(
        this.inputMessage('subject'),
        (input) => (this.subject = input),
        validator
      );
    }
  }

  public async getBody(): Promise<void> {
    if (
      this.next &&
      !ConventionalCommitMessage.shouldSkip(this.czConfig, 'body')
    ) {
      this.next = await ask(
        this.inputMessage('body'),
        (input) => (this.body = input ? wrap(input, 72, { hard: true }) : '')
      );
    } else {
      this.body = '';  // Set empty string instead of undefined
    }
  }

  public async getBreaking(): Promise<void> {
    if (
      this.next &&
      !ConventionalCommitMessage.shouldSkip(this.czConfig, 'breaking') &&
      ConventionalCommitMessage.allowBreakingChanges(this.czConfig, this.type)
    ) {
      this.next = await ask(
        this.inputMessage('breaking'),
        (input) => (this.breaking = input)
      );
    }
  }

  public async getFooter(): Promise<void> {
    if (
      this.next &&
      !ConventionalCommitMessage.shouldSkip(this.czConfig, 'footer')
    ) {
      this.next = await ask(
        this.inputMessage('footer'),
        (input) => (this.footer = input || '')  // Use empty string if no input
      );
    } else {
      this.footer = '';  // Set empty string instead of undefined
    }
  }

  public get complete(): boolean {
    return this.next && Boolean(this.type) && Boolean(this.subject);
  }

  public get messages(): Messages {
    const main = `${this.type}${typeof this.scope === 'string' && this.scope ?
      `(${this.scope})` : ''
      }: ${this.subject}`;
    const body = this.body || '';  // Use empty string if body is undefined
    const footer = this.breaking ?
      `BREAKING CHANGE: ${this.breaking}${this.footer ? '|' + this.messageFooter() : ''}` :
      this.messageFooter();

    return {
      main,
      body,
      footer
    };
  }

  private messageFooter(): string {
    return this.footer
      ? `${this.czConfig && this.czConfig.footerPrefix
        ? this.czConfig.footerPrefix
        : 'Closes '
      }${this.footer}`
      : '';
  }
  private inputMessage(messageType: string): string {
    return ConventionalCommitMessage.hasCustomMessage(
      this.czConfig,
      messageType
    )
      ? this.czConfig.messages[messageType as keyof typeof this.czConfig.messages] ?? DEFAULT_MESSAGES[messageType as keyof typeof DEFAULT_MESSAGES]
      : DEFAULT_MESSAGES[messageType as keyof typeof DEFAULT_MESSAGES];
  }
}

function capitalizeWindowsDriveLetter(path: string): string {
  if (!path) {
    return path;
  }

  return path.replace(/(\w+?):/, (rootElement) => {
    return rootElement.toUpperCase();
  });
}

function getGitCwd(cwd: string): string {
  let cwdForGit = cwd;

  if (getConfiguration().capitalizeWindowsDriveLetter) {
    cwdForGit = capitalizeWindowsDriveLetter(cwd);
  }

  return cwdForGit;
}

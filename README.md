# vscode-commitizen README

![build](https://github.com/KnisterPeter/vscode-commitizen/workflows/build/badge.svg)
[![Marketplace Version](https://vsmarketplacebadge.apphb.com/version/knisterpeter.vscode-commitizen.svg)](https://marketplace.visualstudio.com/items?itemName=KnisterPeter.vscode-commitizen)
[![Installs](https://vsmarketplacebadge.apphb.com/installs/knisterpeter.vscode-commitizen.svg)](https://marketplace.visualstudio.com/items?itemName=KnisterPeter.vscode-commitizen)
[![renovate badge](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovateapp.com/)

This vscode extension adds [commitizen support](https://github.com/commitizen).

It is a fork of [KnisterPeter/vscode-commitizen](https://github.com/KnisterPeter/vscode-commitizen) with following features:

1. Support for more places to look for the config file

## Usage

1. Click blue 'Conventional Commit' button in the Source Control view or open the command panel (`ctrl+shift+p` or `command+shift+p`) and type 'conventional commit'.
2. Select the command and answer the questions afterwards (type, scope, subject, body, breaking changes, closed issues).
3. After the closed issues the commit is done automatically.
4. **Note**: During answering the questions just hit `ESC`to cancel the commit.

## Configuration

To configure this extension follow [cz-customizable](https://github.com/leonardoanalista/cz-customizable) and
create the required config file. This also read by this extension if configured.

To determine what config to use, the extention will look for a config file in the following places:

1. if `commitizen.useGitRoot` setting is set, then look for the config file ```.cz-config.js``` in the git root directory of the workspace
1. a ```.cz-config.js``` in the workspace directory
1. in ```package.json``` in the workspace directory to determine the path to the config file:
   ```
     "config": {
       "cz-customizable": {
         "config": "test.js"
       }
     }
   ```
1. if `commitizen.configAbsPath` setting is set, then look for the config file in the path specified by the setting
1. use the default config

> "commitizen.configAbsPath" supports the `${userHome}` placeholder to refer to the home directory of the user

## Attributions

[Commitizen logo](./images/commitizen-logo.svg) is a remixed version of the [logo created by authors of commitizen cz-cli repository](https://github.com/commitizen/cz-cli/blob/a3f4ffa88221013960cd9c6d8711b319016b9e2d/logo/commitizen-logo-color.svg), under MIT license.

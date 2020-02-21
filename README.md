 # Usage

To get Code Scanning results from CodeQL analysis on your repo you can use the following workflow as a template:

```yaml
name: "CodeQL analysis"

on: [push]

jobs:
  build:

    strategy:
      fail-fast: false

    runs-on: ubuntu-latest # you can try windows too but macos is not yet supported

    steps:
    - uses: actions/checkout@v1
      with:
        submodules: recursive # omit this if your repository doesn't use submodules
    - uses: Anthophila/codeql-action/codeql/init@master
      with:
        languages: go, javascript # comma separated list of values from {go, python, javascript, java, cpp, csharp} (not YET ruby, sorry!)
    - uses: Anthophila/codeql-action/codeql/finish@master
    - uses: Anthophila/codeql-action/codeql/upload-sarif@master
```

If you prefer to integrate this within an existing CI workflow, it should end up looking something like this:
```yaml
...
    - uses: Anthophila/codeql-action/codeql/init@master
      with:
        languages: go, javascript

    # Here is where you build your code
    - run: |  
        make bootstrap
        make release

    - uses: Anthophila/codeql-action/codeql/finish@master
    - uses: Anthophila/codeql-action/codeql/upload-sarif@master
```

If you have any questions you can find us on Slack at #dsp-code-scanning.

And don't forget to leave your feedback on https://github.com/github/dsp-code-scanning/issues/515!

# Troubleshooting

## Trouble with Go dependencies

### If you use a vendor directory

Try passing
```
env:
      GOFLAGS: "-mod=vendor"
```
to `Anthophila/codeql-action/codeql/init`.

### If you do not use a vendor directory

Dependencies on public repositories should just work. If you have dependencies on private repositories, one option is to use `git config` and a [personal access token](https://help.github.com/en/github/authenticating-to-github/creating-a-personal-access-token-for-the-command-line) to authenticate when downloading dependencies. Add a section like
```
    steps:
    - name: Configure git private repo access
      env:
        TOKEN: ${{ secrets.GITHUB_PAT }}
      run: |
        git config --global url."https://${TOKEN}@github.com/github/foo".insteadOf "https://github.com/github/foo"
        git config --global url."https://${TOKEN}@github.com/github/bar".insteadOf "https://github.com/github/bar"
        git config --global url."https://${TOKEN}@github.com/github/baz".insteadOf "https://github.com/github/baz"
```
before any codeql actions. A similar thing can also be done with a SSH key or deploy key.

## C# using dotnet version 2 on linux

This unfortunately doesn't work properly unless `dotnet` is invoked with the `/p:UseSharedCompilation=false` flag. For example:
```
dotnet build /p:UseSharedCompilation=false
```
Version 3 works fine and does not require the additional flag.

## Ruby version 2.6 instead of 2.5

Add a section like
```
steps:
- name: Set up Ruby 2.6
  uses: actions/setup-ruby@v1
  with:
    version: 2.6.x
```

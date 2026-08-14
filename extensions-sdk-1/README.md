# Ableton Extensions SDK (local only)

The Ableton Extensions SDK is not included in this repository. Its license
prohibits redistributing the SDK or its files separately from an application.

Obtain the beta SDK through Ableton's official developer channel, then place
these archives in this directory:

- `ableton-extensions-sdk-1.0.0-beta.1.tgz`
- `ableton-extensions-cli-1.0.0-beta.1.tgz`

The filenames and location are referenced by the root `package.json`. After the
archives are present, run `npm ci` from the repository root.

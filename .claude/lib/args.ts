/**
 * Strict argument parsing for scripts that change state (push, pull, record).
 *
 * A script that silently ignores what it does not understand turns `--help` or a typo into a real run. This
 * parser prints the usage for `--help`/`-h` and exits 0, and rejects any unknown argument with exit 2 – before
 * the script has touched anything.
 */
export interface ArgSpec {
  /** The text printed for `--help` and after an error, starting with `Usage:`. */
  usage: string;
  /** Boolean flags, e.g. `--check`. */
  flags?: string[];
  /** Options that take one value, e.g. `--from <file>`. A lone `-` (stdin) is a value, any other `-…` is not. */
  values?: string[];
  /** Accept story ids (`ST-NNN`) as positional arguments. */
  ids?: boolean;
}

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
  ids: string[];
}

export function parseArgs(spec: ArgSpec, argv: string[] = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const ids: string[] = [];
  const fail = (message: string): never => {
    console.error(`${message}\n\n${spec.usage}`);
    process.exit(2);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(spec.usage);
      process.exit(0);
    }
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (spec.flags?.includes(name) && inline === undefined) flags.add(name);
    else if (spec.values?.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("-") && value !== "-")) fail(`${name} needs a value.`);
      values.set(name, value);
    } else if (spec.ids && /^ST-\d+$/i.test(arg)) ids.push(arg);
    else fail(`Unknown argument: ${arg}`);
  }
  return { flags, values, ids };
}

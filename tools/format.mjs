import ts from 'typescript';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
for (const group of ['packages', 'modules', 'apps']) {
    for (const directory of await readdir(group, { withFileTypes: true })) {
        if (!directory.isDirectory())
            continue;
        const root = join(group, directory.name, 'src');
        for (const file of await readdir(root)) {
            if (!file.endsWith('.ts'))
                continue;
            const path = join(root, file);
            const text = await readFile(path, 'utf8');
            await writeFile(path, printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)));
        }
    }
}
for (const group of ['tools', 'tests'])
    for (const file of await readdir(group)) {
        if (!file.endsWith('.mjs'))
            continue;
        const path = join(group, file), text = await readFile(path, 'utf8');
        await writeFile(path, printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)));
    }

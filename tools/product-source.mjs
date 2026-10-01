import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readCatalogue, validateProduct } from './studio-catalogue.mjs';
/** Writes only one validated product definition to a NEW product directory. No overrides. */
export async function importProduct(root, value) {
    root=resolve(root);
    const catalogue=await readCatalogue(root);
    const product=validateProduct(value,catalogue.modules,catalogue.solutions);
    const parent=join(root,'products');
    if (await realpath(parent)!==parent) throw Error('Product source directory must not be a symlink');
    const dir=join(parent,product.id);
    await mkdir(dir); // atomic collision refusal
    await writeFile(join(dir,'product.json'),JSON.stringify(product,null,2)+'\n',{flag:'wx'});
    return { product, path:`products/${product.id}/product.json`, status:'SOURCE_SAVED_NOT_BUILT' };
}

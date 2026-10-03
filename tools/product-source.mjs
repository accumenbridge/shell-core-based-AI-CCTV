import { mkdir, rmdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readCatalogue, validateProduct } from './studio-catalogue.mjs';
/** Writes only one validated product definition to a NEW product directory. No overrides. */
export async function importProduct(root, value, admit=()=>{}) {
    root=resolve(root);
    const catalogue=await readCatalogue(root);
    admit();
    const product=validateProduct(value,catalogue.modules,catalogue.solutions);
    const parent=join(root,'products');
    const actualParent=await realpath(parent);
    admit();
    if (actualParent!==parent) throw Error('Product source directory must not be a symlink');
    const dir=join(parent,product.id);
    admit();
    await mkdir(dir); // atomic collision refusal
    try {
        admit();
        await writeFile(join(dir,'product.json'),JSON.stringify(product,null,2)+'\n',{flag:'wx'});
    } catch(error) {
        try { await rmdir(dir); } catch { /* Only an empty directory created above is eligible for cleanup. */ }
        throw error;
    }
    return { product, path:`products/${product.id}/product.json`, status:'SOURCE_SAVED_NOT_BUILT' };
}

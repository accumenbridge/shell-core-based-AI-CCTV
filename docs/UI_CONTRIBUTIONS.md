# Workspace UI contributions

Modules may declare a small number of named, read-only panels for the fixed
`workspace.aside` and `workspace.footer` slots. A solution's reviewed `ui.json`
maps a selected module workspace to an exact contribution ID and slot. The
resolver checks the declaration against both the selected composition and the
source catalogue, then the build captures the mapping in the immutable export.
The shell imports only the declared named export from the statically reviewed
module UI bundle; runtime data never becomes an import URL.

Each panel receives a frozen actor/product/instance/tenant scope, the current
permissions, an abort signal tied to that workspace view, a notice callback, and
a read-only `get` client. It cannot borrow another module's write route. A
contribution is trusted same-origin UI code, not an isolated plugin sandbox.
Its request handlers must still rely on owner-side authorization and tenant
filtering. Selection, session, or tenant changes dispose the old panels and
abort their pending requests.

The current Service Desk and Knowledge contributions are optional views over
existing owner data: Knowledge shows indexed document search beside requests,
and Service Desk shows a bounded recent-request list below the Knowledge
library. Missing optional modules produce explicit omissions. These panels do
not add domain tables, grants, provider behavior, or a new API surface.

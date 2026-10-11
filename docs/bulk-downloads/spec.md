# Bulk selection and fast downloads

Approved by Nas on 2026-10-11: implement bulk selection/actions and prepared CDN ZIP downloads, with up to ten source downloads at once.

## Behavior

- Select files and folders using card checkboxes, modifier clicks, and Shift ranges. Normal clicks continue opening files/folders when selection is empty.
- Select all includes every item in the current folder or matching search, including unloaded results. Individual items can be deselected; Escape clears selection. Selection resets on folder, search, or recycle-view changes.
- Show the selection count and Download ZIP, Move, and Move to trash actions. Recycle-bin roots offer Restore and Delete permanently, using the existing permanent-deletion confirmation behavior.
- Folder selection includes active descendants. Overlapping selections are included once. Preserve original bytes, Unicode filenames, empty directories, and directory structure; mixed selections must not collide on filenames.
- Prepare ZIPs in the worker, with visible file progress and explicit failures. Download the completed object using a freshly signed CloudFront URL. Single-file direct downloads remain available.
- Reuse an unexpired archive for an identical snapshot of paths and source objects. Changes to names, membership, or originals invalidate reuse. Temporary archives expire after seven days.
- A download must fail rather than silently omit required files. Bulk action failures identify unsuccessful items and retain them in selection.

## Limits

Preparation is separate from browser transfer. First-time ZIP preparation takes time; completed transfers bypass the VPS. Do not promise a fixed download rate.

Production deployment and infrastructure changes are outside this implementation authorization.

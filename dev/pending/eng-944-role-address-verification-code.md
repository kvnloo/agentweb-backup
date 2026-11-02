## ENG-944: read_verification_code reads codes sent to a role/alias address (2026-11-01)

- New `delivered_to` arg: searches the resolved own/org-shared mailbox with Gmail `deliveredto:` and only accepts a code email whose To/Cc names that address. No persistence; a stored admin alias mapping is a separate data-plane slice.

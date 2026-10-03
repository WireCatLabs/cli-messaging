# Response MIME for streamed downloads

Approved parity repair continuation. Claim fix/download-response-mime.
MAX shared download adoption revealed missing response MIME; a WebP photo can receive the
kind fallback .jpg. RemoteFile MIME may only become known during lazy streaming, and eager
pre-opening every attachment would leak unused files in hearing.

Resolve fallback names after the byte pipeline finishes; retain named files, atomic hard links,
unique/resume semantics and partial cleanup. A generic fake updates MIME during bytes().
Add regression for late MIME and complete-body/pump failure lifecycle. Release blocks MAX
consumer filename correctness; MAX exposes HTTP MIME during its bounded lazy byte stream.
Both consumers pin the prerequisite and run gates. No HEAD/eager account downloads/live calls.

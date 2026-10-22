# Evidence Correction

The two `rea-android-apk-*` JSON files describe a synthetic archive generated
locally in this session, not a genuine Zomato APK. Their hashes authenticate only
that archive. They do not establish any Zomato activities, bytecode, native
libraries, JNI bridges, permissions, or signatures. They are retained only for
auditability and must not be used as evidence about Zomato.

The official website's assetlinks declaration identifies a package association;
it does not authenticate a locally generated archive or reveal app internals.

Web captures and exported JavaScript were observed through REA. The saved graph
summary describes a selected subset of bundles, not complete application coverage.
The route catalog records strings in bundles, not verified API contracts. The
local WebMCP dispatcher, prices, reviews, restaurant details, payment events,
tracking, and reservations are independent demo implementations. Some catalog
fields were informed by website state; much of the catalog is invented seed data.

No genuine Android APK or Zomato server source has been analyzed. Obtain a target
you are authorized to inspect before further APK investigation.
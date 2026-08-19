export const HSS_PUBLIC_PROTOTYPE_CANDIDATE_NOTICE = "HSS_PUBLIC_PROTOTYPE_CANDIDATE_USED_FOR_EXPERIMENT";

export const HSS_CANDIDATE_FUNCTIONS = [
  "JLINK_HSS_GetCaps",
  "JLINK_HSS_Start",
  "JLINK_HSS_Read",
  "JLINK_HSS_Stop",
] as const;

export type HssCandidateFunction = typeof HSS_CANDIDATE_FUNCTIONS[number];

export const HSS_CANDIDATE_SIGNATURES = {
  JLINK_HSS_Start: {
    returnType: "int",
    parameters: [
      { name: "paDesc", type: "JLINK_HSS_MEM_BLOCK_DESC*" },
      { name: "NumBlocks", type: "int" },
      { name: "Period_us", type: "int" },
      { name: "Flags", type: "int" },
    ],
  },
} as const;

export const HSS_CANDIDATE_STRUCTS = {
  HssMemBlockDesc: {
    sizeBytes: 16,
    fields: [
      { name: "Addr", type: "uint32", offsetBytes: 0 },
      { name: "NumBytes", type: "uint32", offsetBytes: 4 },
      { name: "Flags", type: "uint32", offsetBytes: 8 },
      { name: "Dummy", type: "uint32", offsetBytes: 12 },
    ],
  },
  HssCaps: {
    sizeBytes: 32,
    fields: [
      { name: "MaxBlocks", type: "uint32", offsetBytes: 0 },
      { name: "MaxFreq", type: "uint32", offsetBytes: 4 },
      { name: "Caps", type: "uint32", offsetBytes: 8 },
      { name: "aDummy[0]", type: "uint32", offsetBytes: 12 },
      { name: "aDummy[1]", type: "uint32", offsetBytes: 16 },
      { name: "aDummy[2]", type: "uint32", offsetBytes: 20 },
      { name: "aDummy[3]", type: "uint32", offsetBytes: 24 },
      { name: "aDummy[4]", type: "uint32", offsetBytes: 28 },
    ],
  },
} as const;

export function hssApiCandidateReport(officialSdkHeaderFound = false, officialSdkHeaderPath?: string): HssApiCandidateReport {
  return {
    notice: HSS_PUBLIC_PROTOTYPE_CANDIDATE_NOTICE,
    candidateSource: "public header evidence, not official local SDK",
    functionNames: [...HSS_CANDIDATE_FUNCTIONS],
    signatures: HSS_CANDIDATE_SIGNATURES,
    structs: HSS_CANDIDATE_STRUCTS,
    callingConventionCandidate: "Windows x64 default ABI; unverified candidate",
    officialSdkHeaderFound,
    officialSdkHeaderPath,
    publicPrototypeCandidate: true,
    maturity: "experimental",
    productionReady: false,
  };
}

export type HssApiCandidateReport = {
  notice: typeof HSS_PUBLIC_PROTOTYPE_CANDIDATE_NOTICE;
  candidateSource: string;
  functionNames: HssCandidateFunction[];
  signatures: typeof HSS_CANDIDATE_SIGNATURES;
  structs: typeof HSS_CANDIDATE_STRUCTS;
  callingConventionCandidate: string;
  officialSdkHeaderFound: boolean;
  officialSdkHeaderPath?: string;
  publicPrototypeCandidate: true;
  maturity: "experimental";
  productionReady: false;
};

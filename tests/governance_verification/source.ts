import { currentVerificationSource } from "../../web/src/server/verifications/source";

process.stdout.write(JSON.stringify(currentVerificationSource(process.argv[2])) + "\n");

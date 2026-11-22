// Server entrypoint. Listening only; app assembly lives in app.ts.
import dotenv from 'dotenv';
dotenv.config();
import { createApp } from './app';

const port = Number(process.env.PORT || 4100);
const app = createApp();
app.listen(port, () => {
  console.log('BeerPassport admin server listening on port ' + port);
});

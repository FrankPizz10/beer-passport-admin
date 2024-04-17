import React, { useEffect, useState } from 'react';
import { auth } from '../Firebase/firebase';
import { CategoryScale, LinearScale, LineElement, PointElement, Chart, ArcElement, BarElement, Title, Tooltip, Legend } from "chart.js";
import SignupsOverTime from './ChartComponents/SignupsOverTime';
import CountUp from 'react-countup';

import './Analytics.css';
import Engagement from './ChartComponents/Engagement';

interface UserData {
    uid: string,
    email: string,
    displayName: string,
    createdAt: string,
    lastSignedInAt: string,
}

const Analytics: React.FC = () => {
    Chart.register(CategoryScale);
    Chart.register(LinearScale);
    Chart.register(LineElement);
    Chart.register(PointElement);
    Chart.register(ArcElement);
    Chart.register(BarElement);
    Chart.register(Legend);
    Chart.register(Tooltip);
    Chart.register(Title);
    const [signups, setSignups] = useState<string[]>([]);
    const [engagement, setEngagement] = useState<{ [key: string]: number }>({ 'Active': 0, 'Inactive': 0 });

    useEffect(() => {
        const getFirebaseUsersData = async () => {
            const token = await auth.currentUser?.getIdToken();
            const response = await fetch(`${process.env.REACT_APP_API_URL}/admin/firebaseusers`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + token,
                },
            });
            const responseData: UserData[] = await response.json();
            // console.log("User Data: ");
            // console.log(responseData);
            // Extracting relevant data for visualization
            const signups = responseData.map(user => new Date(user.createdAt).toLocaleString('en-us', { month: 'short', year: 'numeric' }));
            setSignups(signups);
            console.log("signups: ", signups);
            const activeVsInactive = responseData.reduce((acc: { [key: string]: number }, user) => {
                const lastSignedIn = new Date(user.lastSignedInAt);
                // if user signed in this month and year active = true
                if (lastSignedIn.getMonth() === new Date().getMonth() && lastSignedIn.getFullYear() === new Date().getFullYear()) {
                    acc['Active']++;
                } else {
                    acc['Inactive']++;
                }
                return acc;
            }, { 'Active': 0, 'Inactive': 0 });
            setEngagement(activeVsInactive);
        };
        getFirebaseUsersData();
    }, []);

  return (
    <div className='analyticsCharts'>
        {signups && signups.length > 0 &&
            <>
                <div className='totals'>
                    <h1>Total Signups</h1>
                    <h1>
                        <CountUp end={signups.length} duration={2.5} useEasing={true} />
                    </h1>
                </div>
                <SignupsOverTime signups={signups}/>
            </>
        }
        {engagement && engagement.Active && engagement.Inactive &&
            <Engagement activeVsInactive={engagement}/>
        }
    </div>
  );
}

export default Analytics;
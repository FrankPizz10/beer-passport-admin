import { useEffect, useState } from "react";
import { Line } from "react-chartjs-2";

import '../Analytics.css';

interface SignupData {
    labels: string[],
    datasets: {
        label: string,
        data: number[],
        backgroundColor: string,
        borderColor: string,
    }[]
}

const total = (tooltipItems: any[]) => {
    let sum = 0;
  
    tooltipItems.forEach(function(tooltipItem) {
      sum += tooltipItem.parsed.y;
    });
    return 'Sum: ' + sum;
  };

const signupsOptions = {
    responsive: true,
    plugins: {
      legend: {
        display: false,
      },
      title: {
        display: true,
        text: 'Signups Over Time',
        font: {
          size: 36,
        },
        color: 'black',
      },
      tooltip: {
        displayColors: false,
        callbacks: {
            label: () => "",
            footer: total,
        }
      }
    },
  };

interface SignupsOverTimeProps {
    signups: string[]
}

const SignupsOverTime = (props: SignupsOverTimeProps) => {
    const [signupData, setSignupData] = useState<SignupData>({} as SignupData);

    function countItemsPerMonth(monthsAndYears: string[]) {
        // Create an object to store the count of items per month
        const countByMonth: { [key: string]: number } = {};
    
        // Loop through the provided data
        monthsAndYears.forEach(item => {
            const [month, year] = item.split(' ');
            const key = new Date(`${month} 1, ${year}`).toISOString();
    
            if (countByMonth[key]) {
                countByMonth[key]++;
            } else {
                countByMonth[key] = 1;
            }
        });
    
        // Define the labels for the x-axis
        const labels = Object.keys(countByMonth).sort();
    
        // Convert sorted labels back to formatted month and year strings
        const formattedLabels = labels.map(label => {
            const date = new Date(label);
            const month = date.toLocaleString('default', { month: 'short' });
            const year = date.getFullYear();
            return `${month} ${year}`;
        });
    
        // Create an array to store the counts per month
        const itemCountsPerMonth = labels.map(label => countByMonth[label]);
    
        return { labels: formattedLabels, itemCountsPerMonth };
    }

    useEffect(() => {
        const { labels, itemCountsPerMonth } = countItemsPerMonth(props.signups);
                const signupDataTemp = {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Items per Month',
                            fill: false,
                            lineTension: 0.1,
                            backgroundColor: 'rgba(75,192,192,0.4)',
                            borderColor: 'rgba(75,192,192,1)',
                            pointBorderColor: 'rgba(75,192,192,1)',
                            pointBackgroundColor: '#fff',
                            pointBorderWidth: 2,
                            pointHoverRadius: 10,
                            pointHoverBackgroundColor: 'rgba(75,192,192,1)',
                            pointHoverBorderColor: 'rgba(220,220,220,1)',
                            pointHoverBorderWidth: 2,
                            pointRadius: 2,
                            pointHitRadius: 10,
                            data: itemCountsPerMonth
                        }
                    ]
                };
                console.log("signupData: ", signupDataTemp);
                setSignupData(signupDataTemp);
    }, [props.signups]);

    return (
        <>
            {signupData && signupData.labels && signupData.labels.length > 0 && signupData.datasets[0].data && signupData.datasets[0].data.length > 0 &&
                <div className="chart">
                    <Line data={signupData} options={signupsOptions} />
                </div>
            }
        </>
    );
}

export default SignupsOverTime;
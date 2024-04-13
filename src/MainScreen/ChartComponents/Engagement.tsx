import { useEffect, useState } from "react";
import { Pie } from "react-chartjs-2";

interface EngagementData {
    labels: string[],
    datasets: {
        data: number[],
        backgroundColor: string[],
        borderColor: string[],
        borderWidth: number
    }[]
}

const pieChartOptions = {
    responsive: true,
    plugins: {
      title: {
        display: true,
        text: 'Engagement',
        font: {
          size: 36,
        },
        color: 'black',
      },
    },
  };

interface EngagementProps {
    activeVsInactive: { [key: string]: number }
}

const Engagement = (props: EngagementProps) => {
    const [engagementChartData, setEngagementChartData] = useState<EngagementData>({} as EngagementData);

    useEffect(() => {
        const engagementChartData = {
            labels: Object.keys(props.activeVsInactive),
            datasets: [{
                data: Object.values(props.activeVsInactive),
                backgroundColor: ['rgba(255, 99, 132, 0.2)', 'rgba(54, 162, 235, 0.2)'],
                borderColor: ['rgba(255, 99, 132, 1)', 'rgba(54, 162, 235, 1)'],
                borderWidth: 1
            }]
        };
        setEngagementChartData(engagementChartData);
    }, [props.activeVsInactive]);

    return (
        <>
            {engagementChartData && engagementChartData.labels && engagementChartData.labels.length > 0 && engagementChartData.datasets[0].data && engagementChartData.datasets[0].data.length > 0 &&
                <div className='chart'>
                    <Pie data={engagementChartData} options={pieChartOptions} />
                </div>
            }
        </>
    );
}

export default Engagement;